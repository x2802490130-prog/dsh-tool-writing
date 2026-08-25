import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SearchIndex } from "./search.js";
import { SqliteIndex } from "./sqlite-index.js";
import { resolveEmbedClient, embedDocs, vectorSearchIdx } from "./embed-manager.js";
import { recordUsage } from "./usage.js";

const LORE_CATEGORIES = ["characters", "world", "timeline", "foreshadowing", "other"];

function cleanRel(rel) {
  const p = path.normalize(String(rel)).replace(/^[\\/]+/, "").replace(/[\\/]+$/, "");
  if (p === "" || p === "." || p.startsWith("..") || path.isAbsolute(p)) {
    throw new Error("dsh-tool-writing: unsafe relative path: " + String(rel));
  }
  return p;
}

function splitTerms(query) {
  return String(query)
    .split(/[\s,，、;；。！？!?：:]+/)
    .map(function (t) { return t.trim(); })
    .filter(function (t) { return t.length > 0; });
}

export function countWords(text) {
  return String(text).replace(/\s/g, "").length;
}

let _workspaceMapCache = null; // { [sessionId]: 工作区目录路径 }，模块级缓存

// 读取 DSH 宿主的工作区注册表（DSH_HOME/storages/workspace.json），
// 建立 会话ID → 工作区目录 的映射。解析失败返回空映射，不影响使用。
function loadWorkspaceMap() {
  if (_workspaceMapCache) return _workspaceMapCache;
  const map = {};
  try {
    const home = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
    const file = path.join(home, "storages", "workspace.json");
    if (fsSync.existsSync(file)) {
      const data = JSON.parse(fsSync.readFileSync(file, "utf8"));
      const ws = data && data.tables && data.tables.workspaces;
      if (ws && typeof ws === "object") {
        for (const key of Object.keys(ws)) {
          const w = ws[key];
          if (w && Array.isArray(w.sessionIds) && w.path) {
            for (const sid of w.sessionIds) map[sid] = w.path;
          }
        }
      }
    }
  } catch (e) {
    /* 注册表读不到/格式变化时静默回退，不阻断写作 */
  }
  _workspaceMapCache = map;
  return map;
}

// 项目根定位（多书隔离核心）：
//   1. 预设显式配置的 projectRoot（专属预设钉死各自的书，优先级最高，行为不变）
//   2. 否则按「当前会话」解析——先查工作区注册表（sessionId → 工作区目录），
//      再回退会话创建时的工作目录（exec.agent.session.header.cwd）
//   3. 最后回退环境变量 DSH_WRITING_PROJECT_ROOT，再进程 cwd
// 返回 { root, source }，source ∈ config | workspace | session | env | cwd，供诊断。
export function resolveProjectRoot(config, execCtx) {
  const explicit = config && config.projectRoot ? String(config.projectRoot).trim() : "";
  if (explicit && explicit !== ".") {
    return { root: path.resolve(explicit), source: "config" };
  }
  const sid = execCtx && execCtx.sessionId;
  if (sid) {
    const wsPath = loadWorkspaceMap()[sid];
    if (wsPath) return { root: path.resolve(wsPath), source: "workspace" };
  }
  const cwd = execCtx && execCtx.cwd;
  if (cwd && cwd.trim().length > 0) {
    return { root: path.resolve(cwd), source: "session" };
  }
  const env = process.env.DSH_WRITING_PROJECT_ROOT;
  if (env && env.trim().length > 0) {
    return { root: path.resolve(env), source: "env" };
  }
  return { root: path.resolve("."), source: "cwd" };
}

export class NovelEngine {
  constructor(config, credentials) {
    this.config = config || {};
    this.credentials = credentials;
    // 显式钉死的 projectRoot（专属预设）：不随会话变化
    const explicit = config && config.projectRoot ? String(config.projectRoot).trim() : "";
    this._configProjectRoot = explicit && explicit !== "." ? path.resolve(explicit) : null;
    // 当前工具调用的会话上下文（setExecContext 由 tools.js 包装层注入）
    this._exec = null;
    // 按会话缓存项目根解析结果：引擎是预设级单例（standing mount，多会话共享实例），
    // root 必须按会话隔离，否则并发会话会互相串书。
    this._roots = new Map();
    this._warned = new Set();
    this._idxConn = null; // 项目索引连接复用（按 root 键控，见 _idx()）
  }

  // 工具调用前由包装层注入：从 exec.agent.session 提取当前会话（id + 创建时工作目录）。
  // 这是宿主提供的「当前会话」信息源（与 todo/bash 等宿主工具一致）。
  setExecContext(exec) {
    const agent = exec && exec.agent;
    const session = agent && agent.session;
    const header = session && session.header;
    this._exec = {
      sessionId: (session && session.id) || (header && header.id) || null,
      cwd: (header && header.cwd) || null
    };
  }

  // 项目根（惰性、按会话解析）：显式钉死 > 工作区注册表(sessionId) > 会话 cwd > 环境变量 > 进程 cwd
  _root() {
    if (this._configProjectRoot) return this._configProjectRoot;
    const key = (this._exec && this._exec.sessionId) || "__nosession__";
    const cached = this._roots.get(key);
    if (cached) return cached.root;
    const resolved = resolveProjectRoot(this.config, this._exec || {});
    this._roots.set(key, resolved);
    if (!this._warned.has(key)) {
      this._warned.add(key);
      this._warnRoot(resolved);
    }
    return resolved.root;
  }

  // 防呆：项目根下没有 novel 工程骨架时提示（挂错预设/未初始化/工作区选错）
  _warnRoot(resolved) {
    try {
      const st = fsSync.statSync(resolved.root);
      if (st.isDirectory()) {
        const hasNovel = fsSync.existsSync(path.join(resolved.root, "novel.json"));
        const hasChapters = fsSync.existsSync(path.join(resolved.root, "chapters"));
        if (!hasNovel && !hasChapters) {
          console.warn("[dsh-tool-writing] 项目根 " + resolved.root + "（来源: " + resolved.source + "）下未发现 novel 工程骨架（novel.json / chapters/）。若是新书请先 novel_init；若这不是期望的书，请检查会话预设或工作区。");
        }
      } else {
        console.warn("[dsh-tool-writing] 项目根 " + resolved.root + "（来源: " + resolved.source + "）不是目录，请检查预设 projectRoot 或工作区路径。");
      }
    } catch (e) {
      console.warn("[dsh-tool-writing] 项目根 " + resolved.root + "（来源: " + resolved.source + "）不存在。若是新书请先 novel_init；若这不是期望的书，请检查会话预设或工作区。");
    }
  }

  _idx() {
    const root = this._root();
    if (!this._idxConns) this._idxConns = new Map();
    let conn = this._idxConns.get(root);
    if (!conn) {
      conn = new SqliteIndex(path.join(root, ".writing-index.sqlite"));
      this._idxConns.set(root, conn);
    }
    return conn;
  }

  // 释放常驻连接（测试/插件卸载时用）
  closeIndex() {
    if (this._idxConns) {
      for (const conn of this._idxConns.values()) {
        try { conn.close(); } catch (e) {}
      }
      this._idxConns.clear();
    }
    if (this._idxConn) {
      try { this._idxConn.close(); } catch (e) {}
      this._idxConn = null;
    }
  }

  // 多 key 拆刀：draft/polish/sync/subagent 各用独立 key（DSH_WRITING_DRAFT_KEY 等），
  // 角色 key 缺失时回退主 key（config.apiKeyEnv / DSH_WRITING_API_KEY）
  async resolveApiKey(role) {
    const KEY_ROLE_ENV = {
      draft: "DSH_WRITING_DRAFT_KEY",
      polish: "DSH_WRITING_POLISH_KEY",
      sync: "DSH_WRITING_SYNC_KEY",
      subagent: "DSH_SUBAGENT_API_KEY"
    };
    const roleEnv = role && KEY_ROLE_ENV[role] ? KEY_ROLE_ENV[role] : null;
    const tryResolve = async function (envName) {
      if (!envName) return null;
      if (this.credentials && typeof this.credentials.resolve === "function") {
        try {
          const hit = await this.credentials.resolve(envName);
          if (hit && hit.value && hit.value.length > 0) return hit.value;
        } catch (e) {}
      }
      const env = process.env[envName];
      if (env && env.length > 0) return env;
      return null;
    }.bind(this);
    if (roleEnv) {
      const roleKey = await tryResolve(roleEnv);
      if (roleKey) return roleKey;
    }
    const mainEnv = this.config.apiKeyEnv || "DSH_WRITING_API_KEY";
    const mainKey = await tryResolve(mainEnv);
    if (mainKey) return mainKey;
    if (this.config.apiKey && this.config.apiKey.length > 0) return this.config.apiKey;
    throw new Error(
      "dsh-tool-writing: no API key. Store " + mainEnv +
      " in the credentials store (Models page) or set it in the environment."
    );
  }

  async generate(opts) {
    opts = opts || {};
    const startAt = Date.now();
    const apiKey = await this.resolveApiKey(opts.keyRole);
    const messages = [];
    if (opts.system && opts.system.length > 0) messages.push({ role: "system", content: opts.system });
    messages.push({ role: "user", content: opts.prompt || "" });
    // opts.deep：高思考强度任务（归纳/拆解/蒸馏）可用深度模型（config.deepModel，如 deepseek-reasoner）
    const model = (opts.deep && this.config.deepModel) ? this.config.deepModel : (this.config.model || "deepseek-chat");
    const body = {
      model: model,
      messages: messages,
      stream: false,
      max_tokens: opts.maxTokens || this.config.maxTokens || 4096
    };
    if (opts.temperature !== undefined) body.temperature = opts.temperature;
    if (opts.json) body.response_format = { type: "json_object" };
    const base = (this.config.baseURL || "https://api.deepseek.com") + "/chat/completions";
    const timeoutMs = opts.timeoutMs || this.config.timeoutMs || 180000;
    // 用量记账（按书标记：book=项目根目录名，tag=通道角色）——多书并发各自记账，互不串
    const bill = function (ok, usage, errMsg) {
      try {
        let book = "";
        try { book = path.basename(this._root()); } catch (e) {}
        recordUsage({
          model: model,
          effort: opts.deep ? "deep" : (opts.keyRole || ""),
          ok: ok,
          promptTokens: (usage && usage.prompt_tokens) || 0,
          completionTokens: (usage && usage.completion_tokens) || 0,
          cacheHit: (usage && usage.prompt_cache_hit_tokens) || 0,
          cacheMiss: (usage && usage.prompt_cache_miss_tokens) || 0,
          durationMs: Date.now() - startAt,
          tag: opts.keyRole || "",
          book: book,
          error: errMsg || ""
        });
      } catch (e) { /* 记账失败绝不拖垮生成 */ }
    }.bind(this);
    const doFetch = function (signal) {
      return fetch(base, {
        method: "POST",
        headers: {
          authorization: "Bearer " + apiKey,
          "content-type": "application/json"
        },
        body: JSON.stringify(body),
        signal: signal
      });
    };
    const mkSignal = function (extra) {
      const t = AbortSignal.timeout(timeoutMs);
      return extra ? AbortSignal.any([extra, t]) : t;
    };
    let res;
    try {
      res = await doFetch(mkSignal(opts.signal));
    } catch (e) {
      // 用户主动取消不重试；网络错误/超时重试一次（全新超时）
      if (opts.signal && opts.signal.aborted) throw e;
      res = await doFetch(AbortSignal.timeout(timeoutMs));
    }
    if (!res.ok) {
      let message = "DeepSeek API error (HTTP " + res.status + ")";
      try {
        const data = await res.json();
        if (data && data.error && data.error.message) message = data.error.message;
      } catch (e) {}
      bill(false, null, message);
      throw new Error(message);
    }
    const data = await res.json();
    const content = data && data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content : "";
    bill(true, data && data.usage, "");
    return typeof content === "string" ? content : "";
  }

  async generateMany(tasks, opts) {
    opts = opts || {};
    if (!tasks || tasks.length === 0) return [];
    const limit = Math.max(1, Math.min(opts.concurrency || this.config.maxConcurrency || 4, tasks.length));
    const results = new Array(tasks.length);
    let next = 0;
    const worker = async function () {
      while (true) {
        const i = next++;
        if (i >= tasks.length) return;
        results[i] = await this.generate(Object.assign({}, tasks[i], { signal: opts.signal, keyRole: opts.keyRole || tasks[i].keyRole, maxTokens: opts.maxTokens || tasks[i].maxTokens }));
      }
    }.bind(this);
    await Promise.all(Array.from({ length: limit }, worker));
    return results;
  }

  // 全局技法库：跨项目共享的写作技法卡（DSH_HOME/global-techniques/*.md），
  // 所有书的 gatherContext 都会注入（每卡截 700 字控 token）。目录不存在/读失败返回空数组。
  async readGlobalTechniques() {
    const out = [];
    try {
      const home = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
      const dir = path.join(home, "global-techniques");
      if (!fsSync.existsSync(dir)) return out;
      const names = fsSync.readdirSync(dir).filter(function (n) { return n.endsWith(".md"); }).sort();
      for (const n of names) {
        try { out.push({ file: n, text: fsSync.readFileSync(path.join(dir, n), "utf8") }); } catch (e) {}
      }
    } catch (e) {}
    return out;
  }

  abs(rel) {
    return path.join(this._root(), cleanRel(rel));
  }

  // 非破坏式铺骨架：只创建缺失的目录/文件，绝不覆盖已有内容（幂等）
  async scaffold(opts) {
    const created = [];
    const dirs = [
      "chapters", "outline", "research", "export",
      "lore/characters", "lore/world", "lore/timeline", "lore/foreshadowing", "lore/other"
    ];
    for (const d of dirs) {
      try { await fs.access(path.join(this._root(), d)); }
      catch (e) { await fs.mkdir(path.join(this._root(), d), { recursive: true }); created.push(d + "/"); }
    }
    const guides = {
      "chapters/README.md": "# chapters/ 章节仓\n\n- 章节文件：分卷用「卷01-风起/001-标题.md」，平铺用「ch001.md」（自动编号）\n- INDEX.md 是自动生成的活目录（章节/字数/状态/摘要），由 novel_sync 维护，不要手改\n- 章节状态机：draft（草稿）→ polished（已润色）→ final（定稿），记录在 novel.json 台账\n- 导出成品用 novel_export，输出到 export/",
      "outline/README.md": "# outline/ 大纲区\n\n- main.md：主线（阶段节奏 + 爽点排布）\n- volumes/*.md：分卷大纲\n- chapters/*.md：章节细纲（可用 novel_outline level=chapter 批量生成）",
      "research/README.md": "# research/ 考据区\n\n- 由 novel_research 自动归纳的资料笔记\n- 审校发现的问题也放这里（novel_review）",
      "export/README.md": "# export/ 导出区\n\n- novel_export 的成品（合并 Markdown / TXT）输出到这里",
      "lore/README.md": "# lore/ 设定总库（五大类）\n\n- characters/：人物卡（front-matter 元数据 + 内嵌演化史）\n- world/：世界观/势力/力量体系\n- timeline/：时间线事件（带 chapterRef）\n- foreshadowing/：伏笔（带 resolvedIn，登记于 foreshadowing.json）\n- other/：plot-log.md 情节日志、style-profile.md 风格指纹等",
      "lore/other/plot-log.md": "# 情节日志\n\n> novel_sync 每次章末编排会自动登记章节摘要。\n"
    };
    for (const rel of Object.keys(guides)) {
      try { await fs.access(this.abs(rel)); }
      catch (e) { await this.writeText(rel, guides[rel]); created.push(rel); }
    }
    let manifest = null;
    try { manifest = await this.readManifest(); }
    catch (e) {
      manifest = {
        title: (opts && opts.title) || "未命名",
        genre: "", synopsis: "", protagonist: "", cheat: "",
        chapters: [], volumes: {}, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
      };
      await this.writeManifest(manifest);
      created.push("novel.json");
    }
    for (const rel of ["foreshadowing.json", "evolution.json"]) {
      try { await fs.access(this.abs(rel)); }
      catch (e) { await this.writeText(rel, JSON.stringify({ entries: [] }, null, 2) + "\n"); created.push(rel); }
    }
    try { await fs.access(this.abs("chapters/INDEX.md")); }
    catch (e) { await this.rebuildCatalog(); created.push("chapters/INDEX.md"); }
    return { created: created, manifest: manifest };
  }

  // 重建活目录：从台账生成 chapters/INDEX.md（分卷分组 + 字数 + 状态 + 摘要）
  // 台账移除章节（写正文删章用）：删文件 + 台账条目 + 刷新活目录
  async removeChapter(chapterId) {
    let manifest = {};
    try { manifest = await this.readManifest(); } catch (e) { return { removed: 0, reason: "no-manifest" }; }
    const chapters = Array.isArray(manifest.chapters) ? manifest.chapters : [];
    const c = chapters.find(function (x) { return x.id === chapterId; });
    if (!c) return { removed: 0, reason: "not-found" };
    try { await this.deleteFile(c.path); } catch (e) {}
    manifest.chapters = chapters.filter(function (x) { return x.id !== chapterId; });
    if (manifest.lastChapter === chapterId) manifest.lastChapter = chapters.length ? chapters[chapters.length - 1].id : "";
    await this.writeManifest(manifest);
    await this.rebuildCatalog();
    return { removed: 1, id: chapterId };
  }

  async rebuildCatalog() {
    let manifest = {};
    try { manifest = await this.readManifest(); } catch (e) {}
    const chapters = Array.isArray(manifest.chapters) ? manifest.chapters : [];
    const lines = [
      "# 目录（自动生成，由 novel_sync 维护）",
      "",
      "> 共 " + chapters.length + " 章 · 更新于 " + new Date().toISOString(),
      ""
    ];
    const byVol = {};
    const volOrder = [];
    for (const c of chapters) {
      const v = c.volume || "未分卷";
      if (!byVol[v]) { byVol[v] = []; volOrder.push(v); }
      byVol[v].push(c);
    }
    for (const v of volOrder) {
      lines.push("## " + v);
      lines.push("");
      lines.push("| # | 章节 | 字数 | 状态 | 摘要 |");
      lines.push("|---|---|---|---|---|");
      for (const c of byVol[v]) {
        const summary = String(c.summary || "").replace(/\n/g, " ").slice(0, 40);
        lines.push("| " + c.id + " | " + (c.title || "（无标题）") + " | " + (c.words || 0) + " | " + (c.status || "draft") + " | " + summary + " |");
      }
      lines.push("");
    }
    if (!volOrder.length) lines.push("（暂无章节，写完第一章后这里会出现自动目录）");
    await this.writeText("chapters/INDEX.md", lines.join("\n") + "\n");
    return { chapters: chapters.length, volumes: volOrder.length };
  }

  async ensureProject(meta) {
    await this.scaffold(meta);
    let manifest = {};
    try { manifest = await this.readManifest(); } catch (e) {}
    const next = Object.assign({}, manifest, meta || {}, { updatedAt: new Date().toISOString() });
    await this.writeManifest(next);
    return next;
  }

  async readManifest() {
    return JSON.parse(await fs.readFile(path.join(this._root(), "novel.json"), "utf8"));
  }

  async writeManifest(obj) {
    await fs.writeFile(path.join(this._root(), "novel.json"), JSON.stringify(obj, null, 2) + "\n", "utf8");
  }

  async readText(rel) {
    return fs.readFile(this.abs(rel), "utf8");
  }

  async writeText(rel, content) {
    const abs = this.abs(rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, "utf8");
    return abs;
  }

  async deleteFile(rel) {
    await fs.unlink(this.abs(rel));
  }

  async listFiles(rel) {
    const abs = this.abs(rel);
    const out = [];
    async function walk(dir) {
      let entries;
      try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch (e) { return; }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) await walk(full);
        else if (/\.(md|txt|json)$/i.test(e.name)) out.push(path.relative(abs, full).split(path.sep).join("/"));
      }
    }
    await walk(abs);
    return out.sort();
  }

  _snippet(text, query) {
    const s = String(text || "");
    const chars = Array.from(new Set(String(query).split("")));
    let at = -1;
    for (const c of chars) { const i = s.indexOf(c); if (i !== -1 && (at === -1 || i < at)) at = i; }
    if (at === -1) return s.slice(0, 160);
    const start = at > 60 ? at - 60 : 0;
    return s.slice(start, start + 160);
  }

  async _indexMetaFile() { return path.join(this._root(), ".writing-index.meta.json"); }
  async _indexDbFile() { return path.join(this._root(), ".writing-index.sqlite"); }

  async _indexFingerprint() {
    const roots = ["lore", "outline", "chapters"];
    const parts = [];
    for (const root of roots) {
      const files = await this.listFiles(root);
      for (const rel of files) {
        const fullRel = root + "/" + rel;
        try {
          const st = await fs.stat(this.abs(fullRel));
          parts.push(fullRel + ":" + Math.round(st.mtimeMs));
        } catch (e) {}
      }
    }
    return parts.join("|");
  }

  async _gatherIndexDocs() {
    const docs = [];
    const roots = ["lore", "outline", "chapters"];
    for (const root of roots) {
      const files = await this.listFiles(root);
      for (const rel of files) {
        const fullRel = root + "/" + rel;
        let text;
        try { text = await this.readText(fullRel); } catch (e) { continue; }
        docs.push({ id: fullRel, ref: fullRel, title: rel, words: text.replace(/\s/g, "").length, content: text, meta: {} });
      }
    }
    return docs;
  }

  async _ensureIndex() {
    let fresh = false;
    try {
      const meta = JSON.parse(await fs.readFile(await this._indexMetaFile(), "utf8"));
      fresh = meta.fingerprint === (await this._indexFingerprint());
    } catch (e) { fresh = false; }
    if (!fresh) await this.buildProjectIndex();
  }

  // 增量索引：内容未变的文档保留向量；内容变化自动作废旧向量（等待重嵌）
  async buildProjectIndex() {
    const docs = await this._gatherIndexDocs();
    const idx = this._idx();
    const wanted = new Set(docs.map(function (d) { return d.id; }));
    for (const d of docs) idx.addDoc(d);
    for (const id of idx.allDocIds()) {
      if (!wanted.has(id)) idx.removeDoc(id);
    }
    await fs.writeFile(await this._indexMetaFile(), JSON.stringify({ fingerprint: await this._indexFingerprint(), generatedAt: Date.now() }) + "\n", "utf8");
  }

  // 纯向量检索；无 key 或尚无向量时返回 null（调用方走字面兜底）
  async vectorSearch(query, opts) {
    opts = opts || {};
    const limit = opts.limit || 8;
    await this._ensureIndex();
    const client = await resolveEmbedClient(this.config, this.credentials);
    if (!client) return null;
    const idx = this._idx();
    let hits = null;
    try { hits = await vectorSearchIdx(idx, query, limit, client); } catch (e) { hits = null; }
    if (!hits) return null;
    return hits.map(function (h) {
      return { rel: h.ref, score: Math.round(h.score * 1000) / 1000, snippet: h.text.slice(0, 200) };
    });
  }

  // 惰性回填：为没有向量的文档补嵌（每次最多 cap 个文档，可反复调用直至完成）
  async embedMissing(opts) {
    opts = opts || {};
    await this._ensureIndex();
    const client = await resolveEmbedClient(this.config, this.credentials);
    if (!client) return this.buildConceptIndex(opts);
    const idx = this._idx();
    const missing = idx.missingVectorDocs();
    const cap = Math.max(1, opts.cap || 15);
    const stats = await embedDocs(idx, missing.slice(0, cap), client, {
      // 快速失败：连续失败 1 批（20 块）即中止，避免无效调用耗尽额度/时间
      shouldAbort: function (s) { return s.failed >= 20; }
    });
    const left = idx.missingVectorDocs().length;
    stats.remaining = left;
    // embedding 失败/中止（额度/网络/key 无效）→ 自动降级概念索引（DeepSeek LLM 概念词）
    if (stats.failed > 0 && stats.embedded === 0) {
      const c = await this.buildConceptIndex(opts);
      stats.reason = "llm-concepts-fallback";
      stats.conceptStats = c;
    }
    return stats;
  }

  // 概念索引（DeepSeek LLM 抽取概念词）：embedding 不可用时的"按含义"检索地基
  // 产物：lore/other/concept-index.json —— { entries: { rel: { concepts: [], updatedAt } } }
  async buildConceptIndex(opts) {
    opts = opts || {};
    const groups = [["lore", "lore"], ["outline", "outline"], ["chapters", "chapters"]];
    const rels = [];
    for (const g of groups) {
      try {
        const files = await this.listFiles(g[0]);
        for (const f of files) { if (/\.md$/.test(f)) rels.push(g[1] + "/" + f); }
      } catch (e) {}
    }
    const store = "lore/other/concept-index.json";
    let prev = {};
    try { prev = JSON.parse(await this.readText(store)); } catch (e) { prev = {}; }
    const entries = prev.entries || {};
    const todo = rels.filter(function (rel) { return !(entries[rel] && entries[rel].concepts); });
    let built = 0, failed = 0;
    for (const rel of todo) {
      try {
        const text = await this.readText(rel);
        const sample = text.slice(0, 2500);
        const out = await this.generate({
          maxTokens: 2000,
          system: "你是索引员。从给定文本抽取最重要的概念词（人名/地名/术语/事件/意象，5~10 个），输出 JSON 对象。只输出概念词，不要解释。",
          prompt: "文本：\n" + sample + "\n\n输出 JSON：{\"concepts\":[\"词1\",\"词2\",\"词3\",...]}"
        });
        let obj = {};
        try { obj = JSON.parse(String(out).replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim()); } catch (e) { failed++; continue; }
        const concepts = Array.isArray(obj.concepts) ? obj.concepts.slice(0, 12).map(String) : [];
        if (!concepts.length) { failed++; continue; }
        entries[rel] = { concepts: concepts, updatedAt: new Date().toISOString() };
        built++;
      } catch (e) { failed++; }
    }
    const total = Object.keys(entries).length;
    await this.writeText(store, JSON.stringify({ entries: entries, meta: { built: built, failed: failed, total: total, updatedAt: new Date().toISOString() } }, null, 2));
    return { embedded: built, failed: failed, reason: "llm-concepts", vocab: total, skipped: todo.length - built - failed };
  }

  // 概念检索：query 用 LLM 展开为概念词，与文档概念求重合度（无向量时的"按含义"召回）
  async conceptSearch(query, limit) {
    limit = limit || 6;
    let store;
    try { store = JSON.parse(await this.readText("lore/other/concept-index.json")); } catch (e) { return null; }
    const entries = store.entries || {};
    const rels = Object.keys(entries).filter(function (r) { return r !== "__meta"; });
    if (!rels.length) return null;
    // query 展开
    let qConcepts = [];
    try {
      const out = await this.generate({
        maxTokens: 1000,
        system: "你是检索员。把用户的检索意图展开为 5~10 个概念词（人名/地名/术语/意象），输出 JSON 数组。",
        prompt: "检索意图：" + String(query).slice(0, 200) + "\n\n输出 JSON：{\"concepts\":[\"词1\",\"词2\",...]}"
      });
      const obj = JSON.parse(String(out).replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim());
      qConcepts = Array.isArray(obj.concepts) ? obj.concepts.map(String) : [];
    } catch (e) { qConcepts = []; }
    const qSet = qConcepts.concat(splitTerms(query)).filter(function (t) { return t.length > 0; });
    if (!qSet.length) return null;
    const scored = [];
    for (const rel of rels) {
      const concepts = entries[rel].concepts || [];
      let hit = 0;
      for (const q of qSet) {
        for (const c of concepts) {
          if (c.indexOf(q) >= 0 || q.indexOf(c) >= 0) { hit++; break; }
        }
      }
      if (hit > 0) scored.push({ rel: rel, score: hit, concepts: concepts });
    }
    scored.sort(function (a, b) { return b.score - a.score; });
    return scored.slice(0, limit).map(function (s) {
      let snippet = "";
      try { snippet = s.rel + "（概念：" + s.concepts.slice(0, 6).join("、") + "）"; } catch (e) {}
      return { rel: s.rel, score: s.score, snippet: snippet };
    });
  }

  async search(query, opts) {
    opts = opts || {};
    const limit = opts.limit || 8;
    await this._ensureIndex();
    const idx = this._idx();
    const docs = idx.query(query, { limit: limit });
    const out = [];
    for (const d of docs) {
      out.push({ rel: d.ref, words: d.words, snippet: this._snippet(d.content, query) });
    }
    return out;
  }

  async vectorSearch(query, opts) {
    opts = opts || {};
    const limit = opts.limit || 8;
    await this._ensureIndex();
    const client = await resolveEmbedClient(this.config, this.credentials);
    if (!client) return null;
    const idx = this._idx();
    let hits = null;
    try { hits = await vectorSearchIdx(idx, query, limit, client); } catch (e) { hits = null; }
    if (!hits || !hits.length) return null;
    return hits.map(function (h) {
      return { rel: h.docId, snippet: h.text, score: h.score };
    });
  }

  async recall(query, opts) {
    return this.search(query, opts);
  }
}
