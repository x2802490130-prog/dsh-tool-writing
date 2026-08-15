import { unzipSync, strFromU8 } from "fflate";

function xmlText(xml, tag) {
  const m = String(xml || "").match(new RegExp("<" + tag + "[^>]*>([\\s\\S]*?)</" + tag + ">", "i"));
  return m ? m[1] : "";
}

function decodeEntities(s) {
  return String(s || "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'");
}

function stripHtml(html) {
  let s = String(html || "");
  s = s.replace(/<script[\s\S]*?<\/script>/gi, " ");
  s = s.replace(/<style[\s\S]*?<\/style>/gi, " ");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/p>/gi, "\n\n");
  s = s.replace(/<[^>]+>/g, "");
  s = decodeEntities(s);
  s = s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

function joinRel(base, rel) {
  const parts = (base + "/" + rel).split("/");
  const out = [];
  for (const p of parts) {
    if (p === "" || p === ".") continue;
    if (p === "..") out.pop();
    else out.push(p);
  }
  return out.join("/");
}

export function parseEpub(buffer) {
  const files = unzipSync(new Uint8Array(buffer));
  const keys = Object.keys(files);
  function readStr(p) {
    const target = p.toLowerCase();
    for (const k of keys) {
      if (k.toLowerCase() === target) return strFromU8(files[k]);
    }
    return null;
  }

  const container = readStr("META-INF/container.xml");
  if (!container) throw new Error("无效 EPUB：缺少 META-INF/container.xml");
  const opfPath = (container.match(/full-path="([^"]+)"/) || container.match(/full-path='([^']+)'/) || [])[1];
  if (!opfPath) throw new Error("无效 EPUB：container.xml 中找不到 OPF 路径");
  const opf = readStr(opfPath);
  if (!opf) throw new Error("无效 EPUB：找不到 OPF 文件 " + opfPath);

  const title = stripHtml(xmlText(opf, "dc:title")) || stripHtml(xmlText(opf, "title"));
  const author = stripHtml(xmlText(opf, "dc:creator")) || stripHtml(xmlText(opf, "creator"));

  const manifest = {};
  let mm;
  const manifestRe = /<item\b[^>]*>/gi;
  while ((mm = manifestRe.exec(opf))) {
    const id = (mm[0].match(/id="([^"]+)"/) || mm[0].match(/id='([^']+)'/) || [])[1];
    const href = (mm[0].match(/href="([^"]+)"/) || mm[0].match(/href='([^']+)'/) || [])[1];
    if (id && href) manifest[id] = href;
  }

  const spine = [];
  let sm;
  const spineRe = /<itemref\b[^>]*>/gi;
  while ((sm = spineRe.exec(opf))) {
    const idref = (sm[0].match(/idref="([^"]+)"/) || sm[0].match(/idref='([^']+)'/) || [])[1];
    if (idref) spine.push(idref);
  }

  const opfDir = opfPath.replace(/[^/]+$/, "");
  const chapters = [];
  let idx = 0;
  for (const idref of spine) {
    const href = manifest[idref];
    if (!href) continue;
    const raw = decodeURIComponent(href.split("#")[0]);
    const rel = joinRel(opfDir, raw);
    const html = readStr(rel);
    if (!html) continue;
    const text = stripHtml(html);
    if (!text) continue;
    idx++;
    const h = (html.match(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/i) || [])[1];
    const chapterTitle = h ? stripHtml(h).slice(0, 80) : ("章节 " + idx);
    chapters.push({ title: chapterTitle, content: text });
  }
  if (chapters.length === 0) throw new Error("EPUB 中未解析出章节内容");
  return { title: title || "", author: author || "", chapters: chapters };
}
