// Minimal EPUB -> chapters parser. Runs entirely in the browser.
/* global JSZip */

const BLOCK_SEL = 'p,h1,h2,h3,h4,h5,h6,li,blockquote,pre,div,td,dt,dd,section,article';

function dirOf(path) {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i + 1);
}

function resolvePath(base, rel) {
  rel = decodeURIComponent(rel.split('#')[0]);
  const parts = (base + rel).split('/');
  const out = [];
  for (const p of parts) {
    if (p === '..') out.pop();
    else if (p !== '.' && p !== '') out.push(p);
  }
  return out.join('/');
}

function parseXml(text) {
  return new DOMParser().parseFromString(text, 'application/xml');
}

function parseHtml(text) {
  let doc = new DOMParser().parseFromString(text, 'application/xhtml+xml');
  if (doc.getElementsByTagName('parsererror').length || !doc.body) {
    doc = new DOMParser().parseFromString(text, 'text/html');
  }
  return doc;
}

function byLocal(root, name) {
  return Array.from(root.getElementsByTagNameNS('*', name));
}

function clean(s) {
  return s.replace(/ /g, ' ').replace(/[ \t\r\f\v]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
}

function extractParagraphs(doc) {
  const body = doc.body || doc.documentElement;
  body.querySelectorAll('script,style,nav,aside[epub\\:type="footnote"]').forEach((n) => n.remove());
  body.querySelectorAll('br').forEach((br) => br.replaceWith('\n'));
  const blocks = Array.from(body.querySelectorAll(BLOCK_SEL)).filter((el) => !el.querySelector(BLOCK_SEL));
  let paras = [];
  if (blocks.length) {
    for (const b of blocks) {
      for (const line of clean(b.textContent).split('\n')) if (line) paras.push(line);
    }
  } else {
    paras = clean(body.textContent).split('\n').filter(Boolean);
  }
  return paras;
}

async function readToc(zip, opf, opfDir, manifest) {
  const map = new Map(); // file path -> label
  // EPUB3 nav
  const navItem = Object.values(manifest).find((m) => (m.properties || '').split(' ').includes('nav'));
  if (navItem) {
    const f = zip.file(navItem.path);
    if (f) {
      const doc = parseHtml(await f.async('string'));
      const navs = Array.from(doc.getElementsByTagName('nav'));
      const toc = navs.find((n) => (n.getAttribute('epub:type') || n.getAttributeNS('http://www.idpf.org/2007/ops', 'type') || '').includes('toc')) || navs[0];
      if (toc) {
        for (const a of toc.getElementsByTagName('a')) {
          const href = a.getAttribute('href');
          if (!href) continue;
          const p = resolvePath(dirOf(navItem.path), href);
          if (!map.has(p)) map.set(p, clean(a.textContent).replace(/\n/g, ' '));
        }
      }
    }
  }
  if (map.size) return map;
  // EPUB2 NCX
  const spine = byLocal(opf, 'spine')[0];
  const ncxId = spine && spine.getAttribute('toc');
  const ncxItem = (ncxId && manifest[ncxId]) || Object.values(manifest).find((m) => m.type === 'application/x-dtbncx+xml');
  if (ncxItem) {
    const f = zip.file(ncxItem.path);
    if (f) {
      const ncx = parseXml(await f.async('string'));
      for (const np of byLocal(ncx, 'navPoint')) {
        const label = byLocal(np, 'text')[0];
        const content = byLocal(np, 'content')[0];
        if (!label || !content) continue;
        const p = resolvePath(dirOf(ncxItem.path), content.getAttribute('src') || '');
        if (!map.has(p)) map.set(p, clean(label.textContent).replace(/\n/g, ' '));
      }
    }
  }
  return map;
}

export async function parseEpub(file, onProgress = () => {}) {
  const zip = await JSZip.loadAsync(file);
  const container = parseXml(await zip.file('META-INF/container.xml').async('string'));
  const opfPath = byLocal(container, 'rootfile')[0].getAttribute('full-path');
  const opfDir = dirOf(opfPath);
  const opf = parseXml(await zip.file(opfPath).async('string'));

  const title = clean((byLocal(opf, 'title')[0] || {}).textContent || file.name.replace(/\.epub$/i, ''));
  const author = clean((byLocal(opf, 'creator')[0] || {}).textContent || '');

  const manifest = {};
  for (const it of byLocal(opf, 'item')) {
    manifest[it.getAttribute('id')] = {
      path: resolvePath(opfDir, it.getAttribute('href')),
      type: it.getAttribute('media-type') || '',
      properties: it.getAttribute('properties') || '',
    };
  }
  const toc = await readToc(zip, opf, opfDir, manifest);
  const spineIds = byLocal(opf, 'itemref').map((r) => r.getAttribute('idref'));

  const chapters = [];
  for (let i = 0; i < spineIds.length; i++) {
    const item = manifest[spineIds[i]];
    if (!item || !/html|xml/.test(item.type)) continue;
    const f = zip.file(item.path);
    if (!f) continue;
    const doc = parseHtml(await f.async('string'));
    let paras = extractParagraphs(doc);
    if (!paras.length || paras.join(' ').length < 20) continue;
    const heading = doc.querySelector('h1,h2,h3');
    const chTitle = toc.get(item.path) || (heading && clean(heading.textContent).replace(/\n/g, ' ')) || paras[0].slice(0, 80);
    // Drop a leading paragraph that just repeats the title (avoid reading it twice)
    if (paras.length > 1 && norm(paras[0]) === norm(chTitle)) paras = paras.slice(1);
    chapters.push({ title: chTitle, paras });
    if (i % 25 === 0) {
      onProgress(i / spineIds.length);
      await new Promise((r) => setTimeout(r));
    }
  }
  onProgress(1);
  return { title, author, chapters };
}

function norm(s) {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export async function parseTxt(file) {
  const text = await file.text();
  const lines = text.split(/\r?\n/);
  const chapters = [];
  let cur = null;
  const isHeading = (l) => /^\s*(chapter|ch\.?|episode|prologue|epilogue|interlude|side story)\b/i.test(l) && l.length < 120;
  for (const raw of lines) {
    const l = raw.trim();
    if (!l) continue;
    if (isHeading(l) || !cur) {
      cur = { title: isHeading(l) ? l : 'Start', paras: [] };
      chapters.push(cur);
      if (isHeading(l)) continue;
    }
    cur.paras.push(l);
  }
  return { title: file.name.replace(/\.[^.]+$/, ''), author: '', chapters: chapters.filter((c) => c.paras.length) };
}
