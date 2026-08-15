import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import * as path from "node:path";

function vecToBlob(vec) {
  const buf = new ArrayBuffer(vec.length * 4);
  const fa = new Float32Array(buf);
  for (let i = 0; i < vec.length; i++) fa[i] = vec[i];
  return new Uint8Array(buf);
}

function blobToVec(u8) {
  const a = u8 instanceof Uint8Array ? u8 : new Uint8Array(u8);
  // 零拷贝视图：直接对 BLOB 的 ArrayBuffer 建 Float32Array，避免逐元素装箱
  return new Float32Array(a.buffer, a.byteOffset, Math.floor(a.byteLength / 4));
}

export class SqliteIndex {
  constructor(filePath) {
    this.filePath = filePath;
    if (filePath !== ":memory:") {
      mkdirSync(path.dirname(filePath), { recursive: true });
    }
    this.db = new DatabaseSync(filePath);
    this.db.exec("CREATE TABLE IF NOT EXISTS docs (id TEXT PRIMARY KEY, ref TEXT, title TEXT, words INTEGER, content TEXT, meta TEXT)");
    this.db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(content, tokenize='trigram')");
    this.db.exec("CREATE TABLE IF NOT EXISTS vectors (docId TEXT NOT NULL, chunkIdx INTEGER NOT NULL, dim INTEGER, vec BLOB, text TEXT, PRIMARY KEY (docId, chunkIdx))");
  }

  rebuild(docs) {
    this.db.exec("DROP TABLE IF EXISTS docs_fts");
    this.db.exec("DROP TABLE IF EXISTS docs");
    this.db.exec("DROP TABLE IF EXISTS vectors");
    this.db.exec("CREATE TABLE docs (id TEXT PRIMARY KEY, ref TEXT, title TEXT, words INTEGER, content TEXT, meta TEXT)");
    this.db.exec("CREATE VIRTUAL TABLE docs_fts USING fts5(content, tokenize='trigram')");
    this.db.exec("CREATE TABLE vectors (docId TEXT NOT NULL, chunkIdx INTEGER NOT NULL, dim INTEGER, vec BLOB, text TEXT, PRIMARY KEY (docId, chunkIdx))");
    for (const d of docs) this.addDoc(d);
  }

  allDocIds() {
    return this.db.prepare("SELECT id FROM docs").all().map(function (r) { return r.id; });
  }

  addDoc(d) {
    const content = String(d.content || "");
    const existing = this.db.prepare("SELECT rowid, content FROM docs WHERE id = ?").get(d.id);
    if (existing) {
      if (existing.content === content) return; // 内容未变：保留 FTS 与向量
      this.db.prepare("UPDATE docs SET ref = ?, title = ?, words = ?, content = ?, meta = ? WHERE id = ?")
        .run(d.ref || "", d.title || "", d.words || 0, content, d.meta ? JSON.stringify(d.meta) : null, d.id);
      this.db.prepare("DELETE FROM docs_fts WHERE rowid = ?").run(existing.rowid);
      this.db.prepare("INSERT INTO docs_fts (rowid, content) VALUES (?, ?)").run(existing.rowid, content);
      // 内容变了 → 旧向量作废，等待重嵌
      this.db.prepare("DELETE FROM vectors WHERE docId = ?").run(d.id);
      return;
    }
    const r = this.db.prepare("INSERT INTO docs (id, ref, title, words, content, meta) VALUES (?, ?, ?, ?, ?, ?)")
      .run(d.id, d.ref || "", d.title || "", d.words || 0, content, d.meta ? JSON.stringify(d.meta) : null);
    const rowid = r.lastInsertRowid;
    this.db.prepare("INSERT INTO docs_fts (rowid, content) VALUES (?, ?)").run(rowid, content);
  }

  removeDoc(id) {
    const row = this.db.prepare("SELECT rowid FROM docs WHERE id = ?").get(id);
    if (row) this.db.prepare("DELETE FROM docs_fts WHERE rowid = ?").run(row.rowid);
    this.db.prepare("DELETE FROM docs WHERE id = ?").run(id);
    this.db.prepare("DELETE FROM vectors WHERE docId = ?").run(id);
  }

  docIdsByRef(ref) {
    return this.db.prepare("SELECT id FROM docs WHERE ref = ?").all(ref).map(function (r) { return r.id; });
  }

  getDoc(id) {
    const r = this.db.prepare("SELECT id, ref, title, words, content, meta FROM docs WHERE id = ?").get(id);
    if (!r) return null;
    return { id: r.id, ref: r.ref, title: r.title, words: r.words, content: r.content, meta: r.meta ? JSON.parse(r.meta) : {} };
  }

  query(q, opts) {
    const limit = (opts && opts.limit) || 10;
    const query = String(q || "").trim();
    if (query.length === 0) return [];
    let rows;
    if (query.length >= 3) {
      try {
        rows = this.db.prepare("SELECT d.id, d.ref, d.title, d.words, d.content, d.meta FROM docs_fts f JOIN docs d ON d.rowid = f.rowid WHERE docs_fts MATCH ? ORDER BY rank LIMIT ?").all(query, limit);
      } catch (e) {
        rows = this.likeQuery(query, limit);
      }
    } else {
      rows = this.likeQuery(query, limit);
    }
    return rows.map(function (r) { return { id: r.id, ref: r.ref, title: r.title, words: r.words, content: r.content, meta: r.meta ? JSON.parse(r.meta) : {} }; });
  }

  likeQuery(query, limit) {
    const like = "%" + query.replace(/[%_\\]/g, "\\$&") + "%";
    return this.db.prepare("SELECT id, ref, title, words, content, meta FROM docs WHERE content LIKE ? ESCAPE '\\' LIMIT ?").all(like, limit);
  }

  // —— 向量 ——
  setVectors(docId, entries) {
    const st = this.db.prepare("INSERT OR REPLACE INTO vectors (docId, chunkIdx, dim, vec, text) VALUES (?, ?, ?, ?, ?)");
    for (const e of entries) {
      if (!e.vec || !e.vec.length) continue;
      st.run(docId, e.idx, e.vec.length, vecToBlob(e.vec), e.text || "");
    }
  }

  hasVectors(docId) {
    const r = this.db.prepare("SELECT COUNT(*) AS c FROM vectors WHERE docId = ?").get(docId);
    return !!(r && r.c > 0);
  }

  vectorCount() {
    const r = this.db.prepare("SELECT COUNT(*) AS c FROM vectors").get();
    return r ? r.c : 0;
  }

  missingVectorDocs() {
    return this.db.prepare("SELECT d.id, d.ref, d.title, d.content FROM docs d WHERE NOT EXISTS (SELECT 1 FROM vectors v WHERE v.docId = d.id)").all()
      .map(function (r) { return { id: r.id, ref: r.ref, title: r.title, content: r.content }; });
  }

  allVectors() {
    return this.db.prepare("SELECT v.docId, v.chunkIdx, v.text, v.vec, d.ref, d.title FROM vectors v LEFT JOIN docs d ON d.id = v.docId").all()
      .map(function (r) { return { docId: r.docId, chunkIdx: r.chunkIdx, text: r.text, vec: blobToVec(r.vec), ref: r.ref, title: r.title }; });
  }

  close() { this.db.close(); }
}
