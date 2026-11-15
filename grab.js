/* Webnovel grabber — runs as a bookmarklet on a webnovel.com chapter page.
   It reads chapters YOUR logged-in browser can already see and hands them
   to the reader app on your phone. Nothing is uploaded anywhere. */
(() => {
  let APP = '__APP_URL__';
  if (APP.startsWith('__')) { // loaded via the short loader: derive app URL from this script's own address
    const me = document.currentScript || Array.from(document.scripts).find((x) => /\/grab\.js/.test(x.src));
    APP = me ? me.src.replace(/grab\.js.*$/, '') : 'https://aikiesan.github.io/webnovel_reader/';
  }
  if (window.__wnGrab) { window.__wnGrab.show(); return; }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const ids = (location.pathname.match(/_(\d{8,})/g) || []).map((s) => s.slice(1));
  const bookId = ids[0];
  let startChapterId = ids[1];
  const csrf = (document.cookie.match(/(?:^|;\s*)_csrfToken=([^;]+)/) || [])[1] || '';

  // ---------- UI ----------
  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;z-index:2147483647;left:8px;right:8px;bottom:8px;background:#16181d;color:#eee;font:15px/1.4 system-ui,sans-serif;padding:14px;border-radius:14px;box-shadow:0 8px 30px #0008;max-height:60vh;overflow:auto';
  box.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
      <b>📖 Send to Reader</b><button data-x style="background:none;border:0;color:#aaa;font-size:22px">✕</button>
    </div>
    <div data-msg style="margin-bottom:10px">How many chapters from here?</div>
    <div data-btns style="display:flex;gap:8px;flex-wrap:wrap">
      ${[1, 10, 25, 50, 100].map((n) => `<button data-n="${n}" style="flex:1;padding:12px 0;border-radius:10px;border:0;background:#2b6cff;color:#fff;font-size:16px">${n}</button>`).join('')}
    </div>
    <pre data-log style="white-space:pre-wrap;font-size:11px;color:#888;margin:8px 0 0;max-height:120px;overflow:auto"></pre>`;
  document.body.appendChild(box);
  const msg = (t) => { box.querySelector('[data-msg]').textContent = t; };
  const log = (t) => { box.querySelector('[data-log]').textContent += t + '\n'; };
  box.querySelector('[data-x]').onclick = () => { box.remove(); delete window.__wnGrab; };
  window.__wnGrab = { show: () => box.scrollIntoView() };

  // ---------- text helpers ----------
  const toParas = (html) => {
    const d = document.createElement('div');
    d.innerHTML = String(html)
      .replace(/<\/?(p|br|div|h\d)[^>]*>/gi, '\n')
      .replace(/<pirate>[\s\S]*?<\/pirate>/gi, '');
    return d.textContent.split(/\n+/).map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean)
      .filter((s) => !/^(find authorized novels|this chapter is updated by|translator:|editor:)/i.test(s));
  };

  // Strategy A: the site's own JSON endpoint (what the page itself uses).
  async function viaApi(chapterId) {
    const u = `/go/pcm/chapter/getContent?_csrfToken=${encodeURIComponent(csrf)}&bookId=${bookId}&chapterId=${chapterId}&encryptType=3&_fsae=0`;
    const r = await fetch(u, { credentials: 'include' });
    const j = await r.json();
    if (j.code !== 0 || !j.data) throw new Error('api code ' + j.code + ' ' + (j.msg || ''));
    const ci = j.data.chapterInfo || {};
    let paras = [];
    if (Array.isArray(ci.contents)) for (const c of ci.contents) paras.push(...toParas(c.content || ''));
    else if (ci.content) paras = toParas(ci.content);
    return {
      id: String(ci.chapterId || chapterId),
      index: ci.chapterIndex,
      title: ci.chapterName || `Chapter ${ci.chapterIndex || ''}`,
      paras,
      next: ci.nextChapterId && String(ci.nextChapterId) !== '-1' && String(ci.nextChapterId) !== '0' ? String(ci.nextChapterId) : null,
      locked: paras.length < 3 && (ci.isAuth === 0 || ci.vipStatus > 0),
      bookName: (j.data.bookInfo || {}).bookName,
    };
  }

  // Strategy B: read what's rendered on the current page.
  function fromDom() {
    const cands = Array.from(document.querySelectorAll('.cha-words, .cha-content, [class*="cha-words"], [class*="chapter-content"], [class*="ChapterContent"], article, main'));
    let best = null, bestLen = 0;
    for (const c of cands.length ? cands : [document.body]) {
      const len = Array.from(c.querySelectorAll('p')).reduce((a, p) => a + p.textContent.length, 0);
      if (len > bestLen) { best = c; bestLen = len; }
    }
    if (!best) return null;
    const paras = Array.from(best.querySelectorAll('p')).map((p) => p.textContent.replace(/\s+/g, ' ').trim()).filter(Boolean);
    const t = document.querySelector('.cha-tit h1, .cha-tit h3, .cha-tit, h1');
    return { id: startChapterId || 'dom', title: t ? t.textContent.trim() : document.title, paras, next: null };
  }

  async function grab(n) {
    box.querySelector('[data-btns]').style.display = 'none';
    const chapters = [];
    let bookName = (document.querySelector('.cha-hd-mn-text a, .det-hd h1, [class*="bookName"]') || {}).textContent;
    let id = startChapterId;
    let apiWorks = !!(bookId && id);
    if (!apiWorks) log('Could not find book/chapter ids in URL — reading this page only.');
    for (let k = 0; k < n && id; k++) {
      msg(`Fetching chapter ${k + 1} of ${n}…`);
      try {
        const c = await viaApi(id);
        if (c.bookName) bookName = c.bookName;
        if (c.locked || !c.paras.length) { log(`Stopped: "${c.title}" is locked or empty.`); break; }
        chapters.push(c);
        log(`✓ ${c.title} (${c.paras.length} paragraphs)`);
        id = c.next;
      } catch (e) {
        log('API failed: ' + e.message);
        apiWorks = false;
        break;
      }
      await sleep(250);
    }
    if (!chapters.length) {
      const d = fromDom();
      if (d && d.paras.length) { chapters.push(d); log(`✓ (from page) ${d.title}`); }
    }
    if (!chapters.length) { msg('Could not find any chapter text on this page 😕'); return; }
    msg(`Got ${chapters.length} chapter(s). How do you want to listen?`);
    const payload = {
      type: 'wn-chapters',
      book: { id: 'wn:' + (bookId || location.pathname), title: (bookName || document.title).trim(), source: location.origin + '/book/' + (bookId || '') },
      chapters: chapters.map(({ id, index, title, paras }) => ({ id, index, title, paras })),
    };
    const appOrigin = new URL(APP).origin;
    const mkBtn = (label, bg) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.style.cssText = `width:100%;padding:14px;border-radius:10px;border:0;background:${bg};color:#fff;font-size:17px;margin-top:6px`;
      return b;
    };
    const float = mkBtn('🎧 Play here (floating player)', '#1fae5b');
    const go = mkBtn('↗ Open in Reader tab', '#444a55');
    box.querySelector('[data-msg]').after(float, go);

    float.onclick = () => {
      document.getElementById('__wn_float')?.remove();
      const wrap = document.createElement('div');
      wrap.id = '__wn_float';
      wrap.style.cssText = 'position:fixed;z-index:2147483647;left:6px;right:6px;bottom:6px;height:170px;border-radius:16px;overflow:hidden;box-shadow:0 8px 30px #000a;background:#16181d;transition:height .2s';
      const bar = document.createElement('div');
      bar.style.cssText = 'position:absolute;top:4px;right:6px;z-index:2;display:flex;gap:4px';
      bar.innerHTML = '<button data-e style="width:34px;height:34px;border-radius:50%;border:0;background:#0007;color:#fff;font-size:16px">⤢</button><button data-c style="width:34px;height:34px;border-radius:50%;border:0;background:#0007;color:#fff;font-size:16px">✕</button>';
      const fr = document.createElement('iframe');
      fr.src = APP + '?import=1&embed=1';
      fr.allow = 'autoplay; clipboard-write';
      fr.style.cssText = 'border:0;width:100%;height:100%;display:block';
      wrap.append(fr, bar);
      document.body.appendChild(wrap);
      let big = false;
      bar.querySelector('[data-e]').onclick = () => { big = !big; wrap.style.height = big ? '75vh' : '170px'; };
      bar.querySelector('[data-c]').onclick = () => { if (confirm('Stop listening and close the player?')) wrap.remove(); };
      let ok = false;
      const onMsg = (e) => {
        if (e.origin !== appOrigin || e.source !== fr.contentWindow || !e.data || e.data.type !== 'wn-ready') return;
        ok = true;
        fr.contentWindow.postMessage(payload, appOrigin);
      };
      window.addEventListener('message', onMsg);
      box.style.display = 'none';
      setTimeout(() => {
        if (ok) return;
        box.style.display = '';
        msg('This site blocked the floating player 😕 Use "Open in Reader tab" instead.');
        wrap.remove();
      }, 15000);
    };

    go.onclick = () => {
      const w = window.open(APP + '?import=1', '_blank');
      if (!w) { msg('Popup blocked — allow popups for this site and tap again.'); return; }
      const onMsg = (e) => {
        if (e.origin !== appOrigin || !e.data || e.data.type !== 'wn-ready') return;
        w.postMessage(payload, appOrigin);
      };
      window.addEventListener('message', onMsg);
      msg('Sent! You can close this panel.');
    };
  }
  box.querySelectorAll('[data-n]').forEach((b) => (b.onclick = () => grab(Number(b.dataset.n))));
})();
