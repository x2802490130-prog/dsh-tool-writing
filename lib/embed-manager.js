import { EmbeddingClient, chunkText, cosine } from "./vector.js";

const DEFAULT_BASE = "https://dashscope.aliyuncs.com/compatible-mode/v1";

// 解析嵌入客户端；无 key 时返回 null（调用方走字面兜底）
export async function resolveEmbedClient(config, credentials) {
  let key = (config && config.embedApiKey) || process.env.DASHSCOPE_API_KEY || "";
  if (!key && credentials && typeof credentials.resolve === "function") {
    for (const name of ["DASHSCOPE_API_KEY", "DSH_WRITING_EMBED_KEY"]) {
      try {
        key = await credentials.resolve(name);
      } catch (e) { key = ""; }
      if (key) break;
    }
  }
  if (!key) return null;
  return new EmbeddingClient({
    embedBaseURL: (config && config.embedBaseURL) || DEFAULT_BASE,
    embedModel: (config && config.embedModel) || "text-embedding-v3",
    embedApiKey: key
  });
}

// 对 docs（{id, content}）做增量嵌入：已有向量的跳过，内容已变（addDoc 作废）的自动补嵌
export async function embedDocs(idx, docs, client, opts) {
  opts = opts || {};
  const stats = { embedded: 0, chunks: 0, skipped: 0, failed: 0 };
  const todo = [];
  for (const d of docs) {
    if (!d || !d.content) { stats.skipped++; continue; }
    if (idx.hasVectors(d.id)) { stats.skipped++; continue; }
    const chunks = chunkText(d.content, opts.chunkSize || 800);
    if (!chunks.length) { stats.skipped++; continue; }
    todo.push({ doc: d, chunks: chunks });
  }
  const batches = [];
  let cur = [];
  for (const t of todo) {
    for (const c of t.chunks) {
      cur.push({ doc: t.doc, chunk: c });
      if (cur.length >= 20) { batches.push(cur); cur = []; }
    }
  }
  if (cur.length) batches.push(cur);
  for (const b of batches) {
    try {
      const vecs = await client.embedBatches(b.map(function (x) { return x.chunk.text; }), { batch: 20 });
      const byDoc = {};
      for (let i = 0; i < b.length; i++) {
        if (!vecs[i]) continue;
        (byDoc[b[i].doc.id] = byDoc[b[i].doc.id] || []).push({ idx: b[i].chunk.idx, text: b[i].chunk.text, vec: vecs[i] });
      }
      for (const docId of Object.keys(byDoc)) {
        idx.setVectors(docId, byDoc[docId]);
        stats.embedded++;
        stats.chunks += byDoc[docId].length;
      }
    } catch (e) {
      stats.failed += b.length;
    }
    if (opts.onProgress) opts.onProgress(stats);
  }
  return stats;
}

// 查询向量缓存：同 query 不重复调嵌入 API（LRU 上限 128）
const queryVecCache = new Map();
const QUERY_CACHE_MAX = 128;

export async function embedQueryCached(client, query) {
  const key = String(query).slice(0, 200);
  const hit = queryVecCache.get(key);
  if (hit) { hit.at = Date.now(); return hit.vec; }
  const vec = (await client.embed([query]))[0];
  if (vec && vec.length) {
    queryVecCache.set(key, { vec: vec, at: Date.now() });
    if (queryVecCache.size > QUERY_CACHE_MAX) {
      let oldest = null, oldestAt = Infinity;
      for (const entry of queryVecCache) {
        if (entry[1].at < oldestAt) { oldestAt = entry[1].at; oldest = entry[0]; }
      }
      if (oldest) queryVecCache.delete(oldest);
    }
  }
  return vec;
}

// 向量检索：返回 null 表示尚无任何向量（调用方字面兜底）
export async function vectorSearchIdx(idx, query, limit, client) {
  const qv = await embedQueryCached(client, query);
  if (!qv || !qv.length) return null;
  const all = idx.allVectors();
  if (!all.length) return null;
  const scored = all.map(function (v) {
    return { docId: v.docId, chunkIdx: v.chunkIdx, text: v.text, ref: v.ref, title: v.title, score: cosine(qv, v.vec) };
  });
  scored.sort(function (a, b) { return b.score - a.score; });
  return scored.slice(0, limit || 8);
}
