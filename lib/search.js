const CJK_RE = /[\u4e00-\u9fff]/;
const ALNUM_RE = /[a-z0-9]/;

export function bigrams(text) {
  const s = String(text || "").toLowerCase();
  const out = new Map();
  let prev = "";
  for (const ch of s) {
    if (CJK_RE.test(ch) || ALNUM_RE.test(ch)) {
      if (prev && (CJK_RE.test(prev) || ALNUM_RE.test(prev))) {
        const bg = prev + ch;
        out.set(bg, (out.get(bg) || 0) + 1);
      }
      prev = ch;
    } else {
      prev = "";
    }
  }
  return out;
}

export class SearchIndex {
  constructor() {
    this.docs = [];
    this.docById = new Map();
    this.postings = new Map();
  }

  addDoc(doc, text) {
    const id = doc.id;
    this.docById.set(id, doc);
    this.docs.push(doc);
    const bg = bigrams(text);
    for (const [b, count] of bg) {
      let p = this.postings.get(b);
      if (!p) { p = new Map(); this.postings.set(b, p); }
      p.set(id, count);
    }
  }

  removeDoc(id) {
    const i = this.docs.findIndex(function (d) { return d.id === id; });
    if (i >= 0) this.docs.splice(i, 1);
    this.docById.delete(id);
    for (const [b, p] of this.postings) {
      if (p.delete(id) && p.size === 0) this.postings.delete(b);
    }
  }

  query(q, opts) {
    opts = opts || {};
    const limit = opts.limit || 10;
    const bg = Array.from(bigrams(q).keys());
    if (bg.length === 0) return [];
    let candidates = null;
    for (const b of bg) {
      const p = this.postings.get(b);
      const ids = p ? Array.from(p.keys()) : [];
      const set = new Set(ids);
      if (candidates === null) candidates = set;
      else {
        const next = new Set();
        for (const id of candidates) if (set.has(id)) next.add(id);
        candidates = next;
      }
      if (candidates.size === 0) return [];
    }
    const scored = [];
    for (const id of candidates) {
      let score = 0;
      for (const b of bg) {
        const p = this.postings.get(b);
        if (p) score += p.get(id) || 0;
      }
      const doc = this.docById.get(id);
      if (doc) scored.push({ doc, score });
    }
    scored.sort(function (a, b) { return b.score - a.score; });
    return scored.slice(0, limit).map(function (s) { return s.doc; });
  }

  serialize() {
    const postings = {};
    for (const [b, p] of this.postings) {
      const obj = {};
      for (const [id, c] of p) obj[id] = c;
      postings[b] = obj;
    }
    return { docs: this.docs, postings: postings };
  }

  static deserialize(data) {
    const idx = new SearchIndex();
    idx.docs = data.docs || [];
    for (const d of idx.docs) idx.docById.set(d.id, d);
    for (const [b, obj] of Object.entries(data.postings || {})) {
      const m = new Map();
      for (const [id, c] of Object.entries(obj)) m.set(id, c);
      idx.postings.set(b, m);
    }
    return idx;
  }
}
