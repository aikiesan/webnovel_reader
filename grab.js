/* Chapter grabber — runs as a bookmarklet on a novel chapter page.
   Reads the chapter you're looking at, follows "Next chapter" links to collect
   the following ones, and hands them to the reader app. Nothing is uploaded. */
(() => {
try {
  let APP = '__APP_URL__';
  if (APP.startsWith('__')) { // loaded via the short loader: derive app URL from this script's own address
    const me = document.currentScript || Array.from(document.scripts).find((x) => /\/grab\.js/.test(x.src));
    APP = me ? me.src.replace(/grab\.js.*$/, '') : 'https://aikiesan.github.io/webnovel_reader/';
  }
  const old = document.getElementById('__rd_box');
  if (old) { old.style.display = ''; return; }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const isWebnovel = /(^|\.)webnovel\.com$/.test(location.hostname) || /\/book\/[^\/]*_\d{15,}/.test(location.pathname);

  // ---------- tiny DOM builder (no innerHTML: works on strict sites) ----------
  const h = (tag, css, text) => { const e = document.createElement(tag); if (css) e.style.cssText = css; if (text != null) e.textContent = text; return e; };
  const btnCss = (bg, fg) => `flex:1;min-width:52px;padding:12px 0;border-radius:999px;border:0;background:${bg};color:${fg || '#0f0a06'};font:600 16px system-ui,sans-serif;margin:0;cursor:pointer`;
  const ACC = '#e89f92', INK = '#efe7d8', MUTED = '#9d9388', P1 = '#0f0a06', P3 = '#271d17';

  const box = h('div', 'all:initial;position:fixed;z-index:2147483647;left:8px;right:8px;bottom:8px;background:#19120e;color:#efe7d8;font:15px/1.45 system-ui,sans-serif;padding:14px;border-radius:14px;box-shadow:0 8px 30px #0008;max-height:65vh;overflow:auto;display:block;box-sizing:border-box');
  box.id = '__rd_box';
  const top = h('div', 'display:flex;justify-content:space-between;align-items:center;margin-bottom:8px');
  top.append(h('b', 'font:400 18px Georgia,serif;color:' + INK, 'Send to Reader'));
  const xBtn = h('button', 'background:none;border:0;color:' + MUTED + ';font-size:22px;padding:0 6px;cursor:pointer', '×');
  xBtn.setAttribute('aria-label', 'Close');
  top.append(xBtn);
  const msgEl = h('div', 'margin-bottom:10px;color:' + INK, 'How many chapters from here?');
  const btns = h('div', 'display:flex;gap:8px;flex-wrap:wrap');
  for (const n of [1, 10, 25, 50, 100]) { const b = h('button', btnCss(P3, INK), String(n)); b.onclick = () => grab(n).catch((e) => { msg('Error: ' + e.message); alert('Reader error: ' + e.message); }); btns.append(b); }
  const actions = h('div', 'display:flex;flex-direction:column;gap:6px');
  const logEl = h('pre', 'white-space:pre-wrap;font:11px/1.4 monospace;color:' + MUTED + ';margin:8px 0 0;max-height:130px;overflow:auto');
  box.append(top, msgEl, btns, actions, logEl);
  (document.body || document.documentElement).appendChild(box);
  const msg = (t) => { msgEl.textContent = t; };
  const log = (t) => { logEl.textContent += t + '\n'; logEl.scrollTop = 1e9; };
  xBtn.onclick = () => box.remove();

  // ---------- generic content extraction ----------
  const JUNK = /(novel\w*\.(com|net|org|me|co)|read (the )?latest chapter|chapter is updated by|find authorized novels|translated by|edited by|please (support|read)|report chapter|^\s*(next|prev(ious)?)( chapter)?\s*$|^advertisement$|tap the screen|use the arrow keys)/i;
  const cleanLines = (lines) => lines.map((s) => s.replace(/\s+/g, ' ').trim()).filter((s) => s && !(s.length < 160 && JUNK.test(s)));

  function textOf(el) {
    const c = el.cloneNode(true);
    c.querySelectorAll('script,style,noscript,iframe,ins,button,select,form,nav,header,footer,aside,[class*="ad-"],[class*="ads"],[id*="ads"]').forEach((n) => n.remove());
    c.querySelectorAll('br').forEach((b) => b.replaceWith('\n'));
    c.querySelectorAll('p,div,h1,h2,h3,h4,li').forEach((b) => { b.prepend('\n'); b.append('\n'); });
    return cleanLines(c.textContent.split(/\n+/));
  }

  function findContent(doc) {
    const pref = doc.querySelector('.cha-words, .chapter-content, #chapter-content, .chr-c, #chr-content, .reading-content, .text-left, .entry-content, #content, .content, article');
    let best = null, bestScore = 0;
    for (const el of doc.querySelectorAll('div,article,section,main,td')) {
      let score = 0;
      for (const ch of el.children) if (ch.tagName === 'P') score += ch.textContent.length;
      for (const n of el.childNodes) if (n.nodeType === 3) score += n.textContent.trim().length;
      if (score > bestScore) { best = el; bestScore = score; }
    }
    if (pref && pref.textContent.trim().length > bestScore * 0.8) return pref;
    return best;
  }

  function findTitle(doc) {
    const t = doc.querySelector('.cha-tit h1, .chr-title, .chapter-title, h1, h2, h3');
    let s = t ? t.textContent.replace(/\s+/g, ' ').trim() : '';
    if (!s || s.length > 150) s = (doc.title || '').trim();
    return s.slice(0, 150);
  }

  function findNext(doc, baseUrl) {
    const links = Array.from(doc.querySelectorAll('a[href]'));
    const rel = doc.querySelector('a[rel~="next"], link[rel~="next"]');
    const scored = [];
    if (rel) scored.push([10, rel.getAttribute('href')]);
    for (const a of links) {
      const t = (a.textContent + ' ' + (a.getAttribute('title') || '') + ' ' + (a.id || '') + ' ' + (a.className || '')).toLowerCase();
      if (/prev/.test(t)) continue;
      let s = 0;
      if (/next\s*chap/.test(t)) s = 9;
      else if (/\bnext\b/.test(t)) s = 6;
      else if (/[→»›]|&gt;/.test(a.textContent)) s = 3;
      if (s) scored.push([s, a.getAttribute('href')]);
    }
    scored.sort((a, b) => b[0] - a[0]);
    for (const [, href] of scored) {
      if (!href || /^(javascript:|#)/i.test(href)) continue;
      const u = new URL(href, baseUrl);
      if (u.origin === location.origin && u.href !== baseUrl) return u.href;
    }
    return null;
  }

  const chapterNum = (s) => { const m = String(s).match(/chapter[\s\-_]*(\d+)/i); return m ? Number(m[1]) : undefined; };

  function chapterFromDoc(doc, url) {
    const el = findContent(doc);
    let paras = el ? textOf(el) : [];
    const title = findTitle(doc);
    if (paras.length && paras[0].replace(/\W/g, '').toLowerCase() === title.replace(/\W/g, '').toLowerCase()) paras = paras.slice(1);
    return { id: url, index: chapterNum(title) ?? chapterNum(url), title, paras, next: findNext(doc, url) };
  }

  async function fetchDoc(url) {
    const r = await fetch(url, { credentials: 'include' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const html = await r.text();
    return new DOMParser().parseFromString(html, 'text/html');
  }

  // ---------- webnovel.com: use the site's own JSON endpoint ----------
  const wnIds = (location.pathname.match(/_(\d{8,})/g) || []).map((s) => s.slice(1));
  const csrf = (document.cookie.match(/(?:^|;\s*)_csrfToken=([^;]+)/) || [])[1] || '';
  const htmlToLines = (html) => { const d = new DOMParser().parseFromString('<div>' + String(html).replace(/<\/?(p|br)[^>]*>/gi, '\n') + '</div>', 'text/html'); return cleanLines(d.body.textContent.split(/\n+/)); };
  async function webnovelChapter(chapterId) {
    const r = await fetch(`/go/pcm/chapter/getContent?_csrfToken=${encodeURIComponent(csrf)}&bookId=${wnIds[0]}&chapterId=${chapterId}&encryptType=3&_fsae=0`, { credentials: 'include' });
    const j = await r.json();
    if (j.code !== 0 || !j.data) throw new Error('api code ' + j.code + ' ' + (j.msg || ''));
    const ci = j.data.chapterInfo || {};
    let paras = [];
    if (Array.isArray(ci.contents)) for (const c of ci.contents) paras.push(...htmlToLines(c.content || ''));
    else if (ci.content) paras = htmlToLines(ci.content);
    const nx = ci.nextChapterId && !['-1', '0'].includes(String(ci.nextChapterId)) ? String(ci.nextChapterId) : null;
    return { id: String(ci.chapterId || chapterId), index: ci.chapterIndex, title: ci.chapterName || 'Chapter ' + (ci.chapterIndex || ''), paras, nextId: nx, bookName: (j.data.bookInfo || {}).bookName };
  }

  // ---------- main ----------
  async function grab(n) {
    btns.style.display = 'none';
    const chapters = [];
    let bookName = '';
    try {
      if (wnIds.length >= 2 && (isWebnovel || /_\d{15,}/.test(location.pathname))) {
        let id = wnIds[1];
        for (let k = 0; k < n && id; k++) {
          msg(`Fetching chapter ${k + 1} of ${n}…`);
          const c = await webnovelChapter(id);
          if (c.bookName) bookName = c.bookName;
          if (c.paras.length < 3) { log(`Stopped: "${c.title}" is locked or empty.`); break; }
          chapters.push(c); log(`✓ ${c.title} (${c.paras.length} paragraphs)`);
          id = c.nextId; await sleep(250);
        }
      }
    } catch (e) { log('webnovel API failed (' + e.message + '), reading pages instead.'); }

    if (!chapters.length) {
      let url = location.href.split('#')[0];
      let doc = document;
      const seen = new Set();
      for (let k = 0; k < n && url && !seen.has(url); k++) {
        seen.add(url);
        msg(`Reading chapter ${k + 1} of ${n}…`);
        try {
          if (k > 0) doc = await fetchDoc(url);
          const c = chapterFromDoc(doc, url);
          if (c.paras.length < 3) { log(`Stopped: no text found at ${url}`); break; }
          chapters.push(c); log(`✓ ${c.title} (${c.paras.length} paragraphs)`);
          if (!c.next) { log('No "next chapter" link found — stopping.'); break; }
          url = c.next;
        } catch (e) { log(`Stopped: ${e.message} at ${url}`); break; }
        await sleep(400);
      }
    }
    if (!chapters.length) { msg('Could not find chapter text on this page. Send a screenshot of this panel.'); return; }

    if (!bookName) {
      const t = (document.title || '').split(/\s*[|–—-]\s*|\s+chapter\s*\d+/i)[0].trim();
      bookName = t || location.hostname;
    }
    const bookKey = isWebnovel && wnIds[0] ? 'wn:' + wnIds[0] : 'site:' + location.hostname + ':' + bookName.toLowerCase().replace(/\W+/g, '-');
    const payload = {
      type: 'wn-chapters',
      book: { id: bookKey, title: bookName, source: location.origin },
      chapters: chapters.map(({ id, index, title, paras }) => ({ id, index, title, paras })),
    };
    msg(`Got ${chapters.length} chapter(s). How do you want to listen?`);
    const appOrigin = new URL(APP).origin;

    const floatBtn = h('button', btnCss(ACC) + ';padding:14px 0', 'Play here in a floating player');
    // A real link (not window.open) so pop-up blockers leave it alone. The chapters
    // travel inside the link itself (#import=…, compressed); the part after # is
    // never sent to any server.
    const tabLink = h('a', btnCss('transparent', INK) + ';box-shadow:inset 0 0 0 1.5px ' + INK + ';padding:14px 0;display:block;text-align:center;text-decoration:none;box-sizing:border-box', 'Open in the Reader tab');
    tabLink.target = '_blank';
    tabLink.rel = 'opener';
    tabLink.href = APP + '?import=1';
    actions.append(floatBtn, tabLink);
    (async () => {
      try {
        const bytes = new TextEncoder().encode(JSON.stringify(payload));
        const gz = new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
        let bin = '';
        for (let i = 0; i < gz.length; i += 0x8000) bin += String.fromCharCode.apply(null, gz.subarray(i, i + 0x8000));
        const b64 = btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        if (b64.length < 1800000) tabLink.href = APP + '#import=' + b64;
        else log('Too many chapters for the link; the Reader tab will ask this page for them instead.');
      } catch (e) { log('Could not pack chapters into the link: ' + e.message); }
    })();
    tabLink.addEventListener('click', (e) => {
      e.stopPropagation(); // keep the site's own click handlers (ads) out of it
      if (!tabLink.href.includes('#import=')) {
        // fallback: the new tab asks us for the chapters with postMessage
        window.addEventListener('message', (ev) => {
          if (ev.origin !== appOrigin || !ev.data || ev.data.type !== 'wn-ready' || !ev.source) return;
          ev.source.postMessage(payload, appOrigin);
        });
      }
      msg('Opening the Reader… You can close this panel.');
    }, true);

    floatBtn.onclick = () => {
      document.getElementById('__rd_float')?.remove();
      const SMALL = 206, BAR = 40;
      const wrap = h('div', `all:initial;position:fixed;z-index:2147483647;left:6px;right:6px;bottom:6px;height:${SMALL}px;border-radius:16px;overflow:hidden;box-shadow:0 8px 30px #000a;background:#19120e;display:flex;flex-direction:column;transition:height .2s;font:14px system-ui,sans-serif`);
      wrap.id = '__rd_float';
      // the player's own controls live in their own strip, never on top of the app
      const bar = h('div', `flex:none;height:${BAR}px;display:flex;align-items:center;gap:6px;padding:0 6px 0 14px;background:#0f0a06;color:#9d9388;font:500 13px system-ui,sans-serif`);
      const label = h('div', 'flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis', 'Reader');
      const ctl = 'width:40px;height:30px;border-radius:999px;border:0;background:#271d17;color:#efe7d8;font:15px system-ui,sans-serif;padding:0;margin:0;cursor:pointer';
      const eBtn = h('button', ctl, '▲');
      eBtn.title = 'Bigger / smaller';
      const cBtn = h('button', ctl, '×');
      cBtn.title = 'Close player';
      bar.append(label, eBtn, cBtn);
      const fr = h('iframe', 'border:0;width:100%;flex:1;display:block;min-height:0');
      fr.src = APP + '?import=1&embed=1';
      fr.allow = 'autoplay; clipboard-write; screen-wake-lock';
      wrap.append(bar, fr);
      (document.body || document.documentElement).appendChild(wrap);
      let big = false;
      eBtn.onclick = () => { big = !big; wrap.style.height = big ? '78vh' : SMALL + 'px'; eBtn.textContent = big ? '▼' : '▲'; };
      cBtn.onclick = () => { if (confirm('Stop listening and close the player?')) wrap.remove(); };
      let ok = false;
      window.addEventListener('message', (e) => {
        if (e.origin !== appOrigin || e.source !== fr.contentWindow || !e.data || e.data.type !== 'wn-ready') return;
        ok = true;
        fr.contentWindow.postMessage(payload, appOrigin);
      });
      box.style.display = 'none';
      setTimeout(() => {
        if (ok) return;
        box.style.display = '';
        msg('This site blocked the floating player. Use "Open in the Reader tab" instead.');
        wrap.remove();
      }, 15000);
    };
  }
} catch (e) {
  alert('Reader bookmarklet error: ' + (e && e.message ? e.message : e));
}
})();
