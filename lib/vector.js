export function chunkText(text, size, overlap) {
  const s = String(text || "").replace(/\r\n/g, "\n");
  const sizeN = size || 800;
  const over = Math.min(overlap || 80, Math.floor(sizeN / 4));
  if (s.length <= sizeN) return [{ idx: 0, text: s }];
  const out = [];
  let start = 0;
  let idx = 0;
  while (start < s.length) {
    let end = Math.min(start + sizeN, s.length);
    if (end < s.length) {
      // 尽量在句末断开，避免截断语义
      const cut = s.lastIndexOf("\n", end);
      if (cut > start + sizeN / 2) end = cut;
    }
    out.push({ idx: idx++, text: s.slice(start, end) });
    if (end >= s.length) break;
    start = end - over;
  }
  return out;
}

export class EmbeddingClient {
  constructor(config) {
    this.config = config || {};
  }

  async embed(texts) {
    const baseURL = this.config.embedBaseURL || "https://dashscope.aliyuncs.com/compatible-mode/v1";
    const apiKey = this.config.embedApiKey || process.env.DASHSCOPE_API_KEY || "";
    if (!apiKey) throw new Error("dsh-tool-writing: 缺少 embedding key（DASHSCOPE_API_KEY）");
    const res = await fetch(baseURL + "/embeddings", {
      method: "POST",
      headers: { authorization: "Bearer " + apiKey, "content-type": "application/json" },
      body: JSON.stringify({ model: this.config.embedModel || "text-embedding-v3", input: texts })
    });
    if (!res.ok) {
      let msg = "embedding HTTP " + res.status;
      try { const j = await res.json(); if (j && j.error && j.error.message) msg = j.error.message; } catch (e) {}
      throw new Error(msg);
    }
    const data = await res.json();
    const items = (data.data || []).sort(function (a, b) { return a.index - b.index; });
    return items.map(function (d) { return d.embedding; });
  }

  async embedBatches(texts, opts) {
    opts = opts || {};
    const batch = Math.min(25, Math.max(1, opts.batch || 20));
    const conc = Math.min(4, Math.max(1, opts.concurrency || 2));
    const parts = [];
    for (let i = 0; i < texts.length; i += batch) parts.push(texts.slice(i, i + batch));
    const out = new Array(texts.length);
    let cursor = 0;
    let done = 0;
    const self = this;
    const worker = async function () {
      while (true) {
        const idx = cursor++;
        if (idx >= parts.length) return;
        let vecs = null;
        try {
          vecs = await self.embed(parts[idx]);
        } catch (e) {
          try { vecs = await self.embed(parts[idx]); } catch (e2) { throw e2; }
        }
        for (let k = 0; k < vecs.length; k++) out[idx * batch + k] = vecs[k];
        done += vecs.length;
        if (opts.onProgress) opts.onProgress({ done: done, total: texts.length });
      }
    };
    const workers = [];
    for (let w = 0; w < conc; w++) workers.push(worker());
    await Promise.all(workers);
    return out;
  }
}

export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  const fa = a instanceof Float32Array ? a : new Float32Array(a);
  const fb = b instanceof Float32Array ? b : new Float32Array(b);
  let dot = 0, na = 0, nb = 0;
  const n = fa.length;
  for (let i = 0; i < n; i++) {
    dot += fa[i] * fb[i];
    na += fa[i] * fa[i];
    nb += fb[i] * fb[i];
  }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d === 0 ? 0 : dot / d;
}
