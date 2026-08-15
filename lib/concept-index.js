/**
 * LLM 概念向量索引：无 embedding key 时的语义检索兜底（纯 DeepSeek API）。
 * 原理：LLM 为每个文档块抽取概念词（带权重 1-3），全库概念词构成稀疏向量空间；
 * 查询同样抽取概念词，按 cosine + idf 加权排序。增量：按内容 hash 跳过未变文档。
 * 相比字面检索：同义/近义概念可命中（如「记忆编织」命中「能力」查询）；
 * 相比稠密 embedding：可解释（能列出命中的概念词），且不依赖第三方 key。
 */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const CONCEPT_SYSTEM = "你是语义索引抽取器。从给定文本抽取最能代表其含义的概念词（2-6字短语），用于语义检索匹配。规则：5-12个；只抽有区分度的概念（人物/事件/情绪/主题/设定/能力/关系）；每个配权重1-3（越核心越高）。输出严格JSON：{\"concepts\":[{\"term\":\"概念\",\"weight\":1}]}"
const MAX_TERMS_PER_DOC = 12
const QUERY_CACHE_MAX = 64

function hashText(t) { return createHash("sha1").update(String(t)).digest("hex").slice(0, 16); }

export class ConceptIndex {
  constructor(stateFile, engine, opts) {
    this.stateFile = stateFile;
    this.engine = engine;
    this.opts = opts || {};
    this.state = { version: 1, vocab: {}, docs: {} };
    this._queryCache = new Map();
    this._load();
  }

  _load() {
    try {
      const j = JSON.parse(readFileSync(this.stateFile, "utf8"));
      if (j && j.version === 1 && j.vocab && j.docs) this.state = j;
    } catch (e) {}
  }

  _save() {
    try {
      mkdirSync(dirname(this.stateFile), { recursive: true });
      writeFileSync(this.stateFile, JSON.stringify(this.state));
    } catch (e) {}
  }

  async _extract(text) {
    const raw = await this.engine.generate({
      effort: "low",
      system: CONCEPT_SYSTEM,
      prompt: String(text).slice(0, 2400),
      json: true,
      maxTokens: 400
    });
    const cleaned = String(raw).replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
    let obj;
    try { obj = JSON.parse(cleaned); } catch (e) { return []; }
    const list = Array.isArray(obj.concepts) ? obj.concepts : [];
    const out = [];
    const seen = {};
    for (const c of list) {
      const term = String((c && c.term) || "").trim();
      if (!term || term.length > 16 || seen[term]) continue;
      seen[term] = 1;
      const w = Math.min(3, Math.max(1, Number(c.weight) || 1));
      out.push({ term: term, weight: w });
      if (out.length >= MAX_TERMS_PER_DOC) break;
    }
    return out;
  }

  /** docs: [{id, content, title, ref}]；增量：content hash 未变则跳过 */
  async buildDocs(docs, opts) {
    opts = opts || {};
    const stats = { embedded: 0, skipped: 0, failed: 0 };
    const N = Object.keys(this.state.docs).length;
    for (const d of docs) {
      if (!d || !d.id || !d.content) { stats.skipped++; continue; }
      const h = hashText(d.content);
      const old = this.state.docs[d.id];
      if (old && old.hash === h) { stats.skipped++; continue; }
      let concepts;
      try { concepts = await this._extract(d.content); } catch (e) { stats.failed++; continue; }
      if (!concepts.length) { stats.failed++; continue; }
      const vec = {};
      for (const c of concepts) {
        let tid = this.state.vocab[c.term];
        if (!tid) {
          tid = String(Object.keys(this.state.vocab).length);
          this.state.vocab[c.term] = { id: tid, df: 0 };
        }
        vec[tid] = Math.max(vec[tid] || 0, c.weight);
        this.state.vocab[c.term].df++;
      }
      this.state.docs[d.id] = { hash: h, title: d.title || "", ref: d.ref || d.id, text: String(d.content).slice(0, 220), vec: vec };
      stats.embedded++;
      if (opts.onProgress) opts.onProgress(stats);
    }
    this._save();
    stats.remaining = 0;
    stats.vocab = Object.keys(this.state.vocab).length;
    return stats;
  }

  /** 稀疏 cosine + idf：score 越高越相似 */
  _score(qv, dv, N) {
    let dot = 0, nq = 0, nd = 0;
    for (const tid of Object.keys(qv)) {
      const qw = qv[tid];
      nq += qw * qw;
    }
    for (const tid of Object.keys(dv)) {
      const dw = dv[tid];
      nd += dw * dw;
      if (qv[tid]) dot += qv[tid] * dw;
    }
    if (!nq || !nd) return 0;
    return dot / Math.sqrt(nq * nd);
  }

  /** 查询翻译：从索引词表中挑选相关概念（词表锚定，提升召回） */
  async _extractQuery(text) {
    const terms = Object.keys(this.state.vocab).slice(0, 400);
    const raw = await this.engine.generate({
      effort: "low",
      system: "你是语义检索的查询翻译器。从给定概念词表中挑选与检索意图最相关的概念词，5-8个，每个配权重1-3（越核心越高）；词表无直接相关词时最多补充2个近义词。输出严格JSON：{\"concepts\":[{\"term\":\"概念\",\"weight\":1}]}",
      prompt: "检索意图：" + text + String.fromCharCode(10) + String.fromCharCode(10) + "概念词表：" + terms.join("、"),
      json: true,
      maxTokens: 400
    });
    const cleaned = String(raw).replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
    let obj;
    try { obj = JSON.parse(cleaned); } catch (e) { return []; }
    const list = Array.isArray(obj.concepts) ? obj.concepts : [];
    const out = [];
    const seen = {};
    for (const c of list) {
      const term = String((c && c.term) || "").trim();
      if (!term || term.length > 16 || seen[term]) continue;
      seen[term] = 1;
      const w = Math.min(3, Math.max(1, Number(c.weight) || 1));
      out.push({ term: term, weight: w });
      if (out.length >= 8) break;
    }
    return out;
  }

  async query(text, limit) {
    const qkey = String(text).slice(0, 200);
    let concepts = this._queryCache.get(qkey);
    if (!concepts) {
      try { concepts = await this._extractQuery(text); } catch (e) { concepts = []; }
      this._queryCache.set(qkey, concepts);
      if (this._queryCache.size > QUERY_CACHE_MAX) this._queryCache.delete(this._queryCache.keys().next().value);
    }
    if (!concepts.length) return [];
    const qv = {};
    for (const c of concepts) {
      const tid = this.state.vocab[c.term] && this.state.vocab[c.term].id;
      if (tid !== undefined) qv[tid] = c.weight;
    }
    if (!Object.keys(qv).length) return [];
    const N = Object.keys(this.state.docs).length;
    const scored = [];
    for (const [docId, doc] of Object.entries(this.state.docs)) {
      const s = this._score(qv, doc.vec, N);
      if (s <= 0) continue;
      const matched = [];
      for (const tid of Object.keys(qv)) {
        if (doc.vec[tid]) {
          const term = Object.keys(this.state.vocab).find(function (t) { return this.state.vocab[t].id === tid; }.bind(this));
          if (term) matched.push(term);
        }
      }
      scored.push({ docId: docId, title: doc.title, ref: doc.ref, text: doc.text, score: Math.round(s * 1000) / 1000, matched: matched.slice(0, 6) });
    }
    scored.sort(function (a, b) { return b.score - a.score; });
    return scored.slice(0, limit || 8);
  }
}
