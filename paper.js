// PDF -> chapters, tuned for scientific papers. Runs entirely in the browser (pdf.js).
//
// What it does, in order:
//  1. reads every text item with its position and size;
//  2. rebuilds lines and puts two-column pages in reading order
//     (full-width title/abstract first, then the left column, then the right);
//  3. drops running headers/footers, page numbers, rotated margin stamps,
//     footnotes and superscript markers, equations and number-heavy table rows;
//  4. joins lines into paragraphs (gaps, indents, short last lines) and rejoins
//     words hyphenated across lines;
//  5. splits at section headings (1 Introduction, 2.1 ..., Abstract, ...);
//     sections become chapters and the References section is skipped.

const KNOWN = /^(abstract|introduction|background|related work|preliminaries|method|methods|methodology|materials and methods|approach|experiments?|experimental setup|evaluation|results|results and discussion|discussion|analysis|limitations|conclusions?|summary|future work|acknowledge?ments?|funding|references|bibliography|literature cited|works cited|appendix|appendices|supplementary material|data availability|author contributions|competing interests|declarations?)$/i;
const REFS = /^(references|bibliography|literature cited|works cited)$/i;
const NUMBERED = /^((\d{1,2}(\.\d{1,2}){0,3})\.?|[IVX]{1,5}\.|[A-H]\.?(\d{1,2}(\.\d{1,2})?)?)\s+([A-Z][^]{0,90})$/;

const median = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
const letters = (s) => (s.match(/\p{L}/gu) || []).length;

export async function parsePdf(file, onProgress = () => {}) {
  const pdfjs = await import('./vendor/pdfjs/pdf.min.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false }).promise;
  let metaTitle = '', metaAuthor = '';
  try { const m = await doc.getMetadata(); metaTitle = (m.info && m.info.Title) || ''; metaAuthor = (m.info && m.info.Author) || ''; } catch {}

  // ---- 1+2: lines per page, in reading order ----
  const pages = [];
  for (let pn = 1; pn <= doc.numPages; pn++) {
    const page = await doc.getPage(pn);
    const vp = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    const items = [];
    for (const it of tc.items) {
      if (!it.str || !it.str.trim()) continue;
      const [a, b, c, d, x, y] = it.transform;
      if (Math.abs(b) > Math.abs(a) * 0.5 || Math.abs(c) > Math.abs(d) * 0.5) continue; // rotated text (margin stamps)
      const size = Math.hypot(c, d) || it.height || 10;
      items.push({ str: it.str, x, y, w: it.width, size });
    }
    pages.push({ pn, w: vp.width, h: vp.height, lines: orderLines(rowsToFrags(items), vp.width) });
    page.cleanup();
    onProgress(pn / doc.numPages * 0.8);
  }

  const all = pages.flatMap((p) => p.lines);
  const bodySize = modeSize(all);

  // ---- 3: drop margins, footnotes, equations ----
  dropRunningHeaders(pages);
  for (const p of pages) {
    const leftEdge = {};
    for (const col of new Set(p.lines.map((l) => l.col))) {
      const xs = p.lines.filter((l) => l.col === col).map((l) => l.x0).sort((a, b) => a - b);
      leftEdge[col] = xs[Math.floor(xs.length * 0.1)] || 0;
    }
    p.lines = p.lines.filter((l) => {
      const t = l.text.trim();
      if (/^[\divxlc]{1,4}$/i.test(t) && (l.y > p.h * 0.88 || l.y < p.h * 0.12)) return false; // page number
      if (/^\(\d{1,3}[a-z]?\)$/.test(t)) return false;                           // equation number on its own
      if (l.cell) return false;                                                 // table cell
      if (/\S+@\S+\.\w+/.test(t) && t.length < 160) return false;               // e-mail lines
      if (/^(arxiv:|doi:|https?:\/\/doi)/i.test(t) && t.length < 80) return false;
      if (l.size < bodySize * 0.82) return false;                               // footnotes, tiny print
      const L = letters(t);
      // equations and number rows; but keep the end of a sentence like "by 23% [1]–[3]."
      if (t.length >= 4 && L / t.length < 0.45 &&
        (l.x0 > leftEdge[l.col] + l.size * 2 || /[=+−∑∫∏√≤≥≈]/.test(t) || !/[.!?]["”’)]?$/.test(t))) return false;
      if (/[=∑∫∏√≤≥≈]/.test(t) && /\(\d{1,3}\)\s*$/.test(t)) return false;        // numbered equation
      return true;
    });
  }

  // ---- 4: paragraphs ----
  const paras = toParagraphs(pages.flatMap((p) => p.lines), bodySize);

  // ---- 5: sections ----
  let title = cleanTitle(metaTitle);
  if (!title) {
    const first = pages[0] ? pages[0].lines.filter((l) => l.size >= bodySize * 1.25) : [];
    const big = first.length ? Math.max(...first.map((l) => l.size)) : 0;
    title = first.filter((l) => l.size >= big - 0.5).map((l) => l.text).join(' ').trim();
  }
  if (!title) title = file.name.replace(/\.pdf$/i, '');

  const chapters = [];
  let cur = null, skipping = false, sawAbstract = false;
  const isHeading = (p) => p.heading;
  for (const p of paras) {
    if (isHeading(p)) {
      const name = p.text.replace(NUMBERED, '$6').trim() || p.text;
      const top = isTopLevel(p.text);
      if (REFS.test(name)) { skipping = true; cur = null; continue; }
      if (skipping && !(top || /^appendix|^supplementary/i.test(name))) continue;
      if (top || !cur) {
        skipping = false;
        if (/^abstract$/i.test(name)) sawAbstract = true;
        cur = { title: p.text.replace(/\s+/g, ' '), paras: [] };
        chapters.push(cur);
      } else cur.paras.push(p.text.replace(/\s+/g, ' ') + '.');
      continue;
    }
    if (skipping) continue;
    // "Abstract—We present ..." / "Abstract. We ..." on one line (IEEE, Springer)
    const ab = !sawAbstract && p.text.match(/^abstract\s*[.:—–-]\s*(.+)$/i);
    if (ab) { sawAbstract = true; cur = { title: 'Abstract', paras: [ab[1]] }; chapters.push(cur); continue; }
    if (!cur) { cur = { title: 'Opening', paras: [], front: true }; chapters.push(cur); }
    cur.paras.push(p.text);
  }
  // Everything before the abstract is the title block (title, authors, affiliations).
  const ai = chapters.findIndex((c) => /^abstract$/i.test(c.title.replace(NUMBERED, '$6').trim()));
  if (ai > 0) chapters.splice(0, ai);
  else if (chapters[0] && chapters[0].front) {
    if (chapters.length > 1) chapters.shift(); else chapters[0].title = title;
  }
  onProgress(1);
  const out = chapters.filter((c) => c.paras.some((t) => letters(t) > 3));
  return { title, author: cleanTitle(metaAuthor), kind: 'paper', chapters: out };
}

function cleanTitle(t) {
  t = String(t || '').replace(/\s+/g, ' ').trim();
  if (!t || t.length < 6 || /^(untitled|microsoft word|document\d*|paper\d*)/i.test(t) || /\.(docx?|tex|pdf|dvi)$/i.test(t)) return '';
  return t;
}

function modeSize(lines) {
  const w = new Map();
  for (const l of lines) { const k = Math.round(l.size * 2) / 2; w.set(k, (w.get(k) || 0) + l.text.length); }
  let best = 10, bw = -1;
  for (const [k, v] of w) if (v > bw) { best = k; bw = v; }
  return best;
}

// Group items into rows by baseline, then split each row where there is a big
// horizontal gap (that is how two columns on the same baseline separate).
function rowsToFrags(items) {
  items.sort((a, b) => b.y - a.y || a.x - b.x);
  const rows = [];
  for (const it of items) {
    const r = rows.find((r) => Math.abs(r.y - it.y) < Math.max(2, Math.min(r.size, it.size) * 0.45));
    if (r) { r.items.push(it); r.size = Math.max(r.size, it.size); } else rows.push({ y: it.y, size: it.size, items: [it] });
  }
  const frags = [];
  for (const r of rows) {
    r.items.sort((a, b) => a.x - b.x);
    const main = Math.max(...r.items.map((i) => i.size));
    let f = null;
    for (const it of r.items) {
      if (it.size < main * 0.72 && /^[\d,\s*†‡§¶a-z–-]{1,8}$/.test(it.str.trim())) continue; // superscript markers
      const gap = f ? it.x - f.x1 : 0;
      if (!f || gap > main * 1.2) {
        if (f) frags.push(f);
        f = { x0: it.x, x1: it.x + it.w, y: r.y, size: it.size, text: it.str };
      } else {
        const needSpace = gap > it.size * 0.12 && !/\s$/.test(f.text) && !/^\s/.test(it.str);
        f.text += (needSpace ? ' ' : '') + it.str;
        f.x1 = Math.max(f.x1, it.x + it.w);
        f.size = Math.max(f.size, it.size);
      }
    }
    if (f) frags.push(f);
  }
  frags.forEach((f) => { f.text = f.text.replace(/\s+/g, ' ').trim(); });
  return frags;
}

// Two-column pages: full-width lines (title, abstract, wide figures) come in
// their place from top to bottom; between them, the whole left column is read
// before the right one.
function orderLines(frags, pageW) {
  const mid = pageW / 2;
  const left = frags.filter((f) => f.x1 < mid + 6).length;
  const right = frags.filter((f) => f.x0 > mid - 6).length;
  const twoCol = left >= 4 && right >= 4;
  const out = [];
  // a row cut into several pieces within one column is a table row
  const rowKey = (f) => Math.round(f.y) + ':' + (twoCol ? (f.x0 < mid ? 'L' : 'R') : '');
  const perRow = new Map();
  for (const f of frags) perRow.set(rowKey(f), (perRow.get(rowKey(f)) || 0) + 1);
  for (const f of frags) if (perRow.get(rowKey(f)) >= (twoCol ? 2 : 3)) f.cell = true;
  if (!twoCol) { frags.forEach((f) => out.push({ ...f, col: 0 })); return out; }
  let L = [], R = [];
  const flush = () => { out.push(...L.map((f) => ({ ...f, col: 0 })), ...R.map((f) => ({ ...f, col: 1 }))); L = []; R = []; };
  for (const f of frags) {
    const full = f.x0 < mid - 24 && f.x1 > mid + 24;
    if (full) { flush(); out.push({ ...f, col: -1 }); }
    else if (f.x0 < mid) L.push(f);
    else R.push(f);
  }
  flush();
  return out;
}

// A line that repeats (digits ignored) at the top or bottom of several pages is
// a running header/footer.
function dropRunningHeaders(pages) {
  if (pages.length < 2) return;
  const key = (t) => t.replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().toLowerCase();
  const count = new Map();
  for (const p of pages) {
    const seen = new Set();
    for (const l of p.lines) if (l.y > p.h * 0.9 || l.y < p.h * 0.1) seen.add(key(l.text));
    for (const k of seen) count.set(k, (count.get(k) || 0) + 1);
  }
  const need = Math.max(2, Math.ceil(pages.length * 0.5));
  for (const p of pages) p.lines = p.lines.filter((l) => !((l.y > p.h * 0.9 || l.y < p.h * 0.1) && count.get(key(l.text)) >= need));
}

function isTopLevel(text) {
  const t = text.trim();
  if (KNOWN.test(t)) return true;
  const m = t.match(NUMBERED);
  if (!m) return false;
  return /^\d{1,2}\.?$/.test(m[1]) || /^[IVX]{1,5}\.$/.test(m[1]) || /^[A-H]\.?$/.test(m[1]);
}

function looksLikeHeading(l, bodySize, afterBreak) {
  const t = l.text.trim();
  if (t.length > 100 || t.length < 3 || /[.,;:]$/.test(t) && !/^\d/.test(t)) return false;
  if (KNOWN.test(t)) return true;
  const nm = t.match(NUMBERED);
  if (nm && !/[.!?]\s+\S/.test(nm[6]) && letters(nm[6]) >= 3) return afterBreak && t.length <= 80 && l.size >= bodySize * 0.98;
  return l.size >= bodySize * 1.12 && letters(t) / t.length > 0.6 && t.split(' ').length <= 12;
}

function toParagraphs(lines, bodySize) {
  // typical distance between consecutive body lines
  const gaps = [];
  for (let i = 1; i < lines.length; i++) {
    const a = lines[i - 1], b = lines[i];
    if (a.col === b.col && Math.abs(a.size - bodySize) < 0.6 && Math.abs(b.size - bodySize) < 0.6 && a.y > b.y) gaps.push(a.y - b.y);
  }
  const lineGap = median(gaps.filter((g) => g < bodySize * 3)) || bodySize * 1.2;
  // left edge and right edge of each column
  const edges = {};
  for (const l of lines) {
    const e = edges[l.col] || (edges[l.col] = { xs: [], ends: [] });
    e.xs.push(Math.round(l.x0)); e.ends.push(Math.round(l.x1));
  }
  for (const k in edges) {
    const xs = edges[k].xs.sort((a, b) => a - b), ends = edges[k].ends.sort((a, b) => a - b);
    edges[k].left = xs[Math.floor(xs.length * 0.1)];
    edges[k].right = ends[Math.floor(ends.length * 0.9)];
  }

  const paras = [];
  let cur = null, prev = null;
  const push = () => { if (cur) paras.push(cur); cur = null; };
  for (const l of lines) {
    // a numbered heading must start after a paragraph end, a gap, or a column/page change
    const afterBreak = !prev || prev.col !== l.col || !(prev.y > l.y) || prev.y - l.y > lineGap * 1.3 || /[.!?:]["”’)]?$/.test(prev.text) || !!(paras.length && paras[paras.length - 1].heading && !cur);
    const head = looksLikeHeading(l, bodySize, afterBreak);
    if (head) { push(); paras.push({ text: l.text, heading: true }); prev = l; continue; }
    let br = !cur;
    if (cur && prev) {
      const e = edges[l.col] || { left: l.x0, right: l.x1 };
      const sameFlow = prev.col === l.col && prev.y > l.y;
      if (Math.abs(l.size - prev.size) > 0.8) br = true;                                   // style change
      else if (sameFlow && prev.y - l.y > lineGap * 1.45) br = true;                      // blank space
      else if (l.x0 > e.left + l.size * 0.7 && l.x0 < e.left + l.size * 4) br = true;     // first-line indent
      else if (/[.!?:]["”’)]?$/.test(prev.text) && prev.x1 < (edges[prev.col] || e).right - prev.size * 2.5) br = true; // short last line
    }
    if (br) { push(); cur = { text: l.text }; }
    else cur.text = joinLines(cur.text, l.text);
    prev = l;
  }
  push();
  return paras;
}

function joinLines(a, b) {
  // "noticea-" + "ble" -> "noticeable"; keep real dashes ("state-of-the-" + "art" stays readable)
  if (/\p{L}-$/u.test(a) && /^\p{Ll}/u.test(b)) return a.slice(0, -1) + b;
  return a + ' ' + b;
}

// Make a paper's sentences pleasant to listen to: no citation markers,
// abbreviations and symbols spelled out.
export function paperSpeech(s) {
  return s
    .replace(/\s?\[(?:\d+(?:\s*[,–-]\s*\d+)*)\]/g, '')                                   // [12], [3, 5–7]
    .replace(/\s?\[[A-Z][^\]]{0,60}?(?:19|20)\d{2}[a-z]?\]/g, '')                       // [Smith 2020]
    .replace(/\s?\((?=[^()]*\b(?:19|20)\d{2}[a-z]?\b)(?:see |e\.g\.,? |cf\. )?[A-Z][^()]{0,160}\)/g, '') // (Smith et al., 2020; ...)
    .replace(/\bet al\.\s*\((?:19|20)\d{2}[a-z]?\)/g, 'and colleagues')
    .replace(/\bet al\./g, 'and colleagues')
    .replace(/(\p{L})²/gu, '$1 squared').replace(/(\p{L})³/gu, '$1 cubed')
    .replace(/[¹²³⁴⁵⁶⁷⁸⁹⁰*†‡]+(?=[\s.,;:]|$)/g, '')
    .replace(/\be\.g\.,?/gi, 'for example,').replace(/\bi\.e\.,?/gi, 'that is,').replace(/\bcf\./gi, 'compare')
    .replace(/\bFigs\./g, 'Figures').replace(/\bFig\./g, 'Figure').replace(/\bEqs\./g, 'Equations').replace(/\bEq\./g, 'Equation')
    .replace(/\bSects?\./g, 'Section').replace(/\bSec\./g, 'Section').replace(/\bTab\./g, 'Table').replace(/\bRef\./g, 'Reference')
    .replace(/\bvs\./g, 'versus').replace(/\bapprox\./g, 'approximately').replace(/\bresp\./g, 'respectively').replace(/\bw\.r\.t\./g, 'with respect to')
    .replace(/\bp\s*<\s*/g, 'p less than ').replace(/\bp\s*>\s*/g, 'p greater than ').replace(/\bp\s*=\s*/g, 'p equals ')
    .replace(/\s*±\s*/g, ' plus or minus ').replace(/\s*≤\s*/g, ' less than or equal to ').replace(/\s*≥\s*/g, ' greater than or equal to ')
    .replace(/\s*≈\s*/g, ' approximately ').replace(/~\s?(?=\d)/g, 'about ').replace(/(\d)\s*×\s*(\d)/g, '$1 times $2')
    .replace(/\s+<\s+/g, ' less than ').replace(/\s+>\s+/g, ' greater than ').replace(/\s+=\s+/g, ' equals ')
    .replace(/°C\b/g, ' degrees Celsius').replace(/°/g, ' degrees')
    .replace(/[αβγδεθλμσπΔΩ]/g, (c) => ' ' + { α: 'alpha', β: 'beta', γ: 'gamma', δ: 'delta', ε: 'epsilon', θ: 'theta', λ: 'lambda', μ: 'mu', σ: 'sigma', π: 'pi', Δ: 'delta', Ω: 'omega' }[c] + ' ')
    .replace(/\(\s*\)/g, '').replace(/\s+([.,;:])/g, '$1').replace(/\s{2,}/g, ' ');
}
