import { parseEpub, parseTxt } from './epub.js';

const $ = (s) => document.querySelector(s);
const params = new URLSearchParams(location.search);
const MOCK = params.has('mock');
const EMBED = params.has('embed');
if (EMBED) document.documentElement.classList.add('embed');

const VOICES = [
  ['af_heart', 'Heart (US, female) ★ best'],
  ['af_bella', 'Bella (US, female) ★'],
  ['af_nicole', 'Nicole (US, female, soft)'],
  ['bf_emma', 'Emma (UK, female)'],
  ['am_fenrir', 'Fenrir (US, male)'],
  ['am_michael', 'Michael (US, male)'],
  ['am_puck', 'Puck (US, male)'],
  ['bm_george', 'George (UK, male)'],
  ['af_aoede', 'Aoede (US, female)'],
  ['af_kore', 'Kore (US, female)'],
  ['af_sarah', 'Sarah (US, female)'],
];
const AHEAD_CHUNKS = 40; // ~10+ minutes of audio generated ahead
const MAX_INFLIGHT = 2;

// ---------- settings ----------
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const settings = {
  voice: store.get('voice', 'af_heart'),
  rate: store.get('rate', 1.0),
  device: store.get('device', 'auto'),
};

// ---------- IndexedDB ----------
function db() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('novel-tts', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('books', { keyPath: 'id' });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function idb(mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const tx = d.transaction('books', mode);
    const req = fn(tx.objectStore('books'));
    tx.oncomplete = () => res(req && req.result);
    tx.onerror = () => rej(tx.error);
  });
}
const saveBook = (b) => idb('readwrite', (s) => s.put(b));
const getBook = (id) => idb('readonly', (s) => s.get(id));
const deleteBook = (id) => idb('readwrite', (s) => s.delete(id));
const listBooks = async () => {
  const all = await idb('readonly', (s) => s.getAll());
  return (all || []).map((b) => ({ id: b.id, title: b.title, author: b.author, n: b.chapters.length }));
};

// ---------- text -> speakable chunks ----------
function speakable(s) {
  return s
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[【〖「『\[<{]/g, ' ')
    .replace(/[】〗」』\]>}]/g, ', ')
    .replace(/…/g, '...')
    .replace(/[~*_=#|]+/g, ' ')
    .replace(/\.\s*\./g, '.').replace(/(\.\s*){2,}/g, '... ')
    .replace(/\s+/g, ' ')
    .trim();
}
const hasWords = (s) => /[A-Za-z0-9]/.test(s);

function splitLong(s, max) {
  if (s.length <= max) return [s];
  const out = [];
  let rest = s;
  while (rest.length > max) {
    let cut = Math.max(rest.lastIndexOf(', ', max), rest.lastIndexOf('; ', max), rest.lastIndexOf(' - ', max));
    if (cut < max * 0.4) cut = rest.lastIndexOf(' ', max);
    if (cut <= 0) cut = max;
    out.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1).trim();
  }
  if (rest) out.push(rest);
  return out;
}

function buildChunks(chapter) {
  const MAX = 280, MERGE = 140;
  const chunks = [{ text: speakable(chapter.title) + '.', p0: -1, p1: -1 }];
  let cur = null;
  const flush = () => { if (cur && hasWords(cur.text)) chunks.push(cur); cur = null; };
  chapter.paras.forEach((para, pi) => {
    const t = speakable(para);
    if (!hasWords(t)) return;
    if (cur && cur.text.length >= MERGE) flush();
    const sentences = t.match(/[^.!?]+(?:[.!?]+["'”’)]*|$)\s*/g) || [t];
    for (let s of sentences) {
      s = s.trim();
      if (!s) continue;
      for (const piece of splitLong(s, MAX)) {
        if (cur && cur.text.length + piece.length + 1 > MAX) flush();
        if (!cur) cur = { text: piece, p0: pi, p1: pi };
        else { cur.text += ' ' + piece; cur.p1 = pi; }
      }
    }
  });
  flush();
  return chunks;
}

// ---------- state ----------
let book = null;
let pos = { ch: 0, i: 0 };
let playing = false;
let waiting = false;
let ttsReady = false;
let ttsDevice = '';
const chunkCache = new Map(); // ch -> chunks
const audio = new Map(); // "ch:i" -> {url, dur, failed}
const pending = new Map(); // reqId -> key
let reqId = 0;
let epoch = 0; // bump to invalidate in-flight work (voice change)

const el = $('#player');
const key = (p) => `${p.ch}:${p.i}`;
const chunksOf = (ch) => {
  if (!chunkCache.has(ch)) chunkCache.set(ch, buildChunks(book.chapters[ch]));
  return chunkCache.get(ch);
};
function step(p, dir = 1) {
  let { ch, i } = p;
  i += dir;
  if (i >= chunksOf(ch).length) { ch++; i = 0; if (ch >= book.chapters.length) return null; }
  if (i < 0) { ch--; if (ch < 0) return null; i = chunksOf(ch).length - 1; }
  return { ch, i };
}
const cmp = (a, b) => (a.ch - b.ch) || (a.i - b.i);

// silent audio to hold the media session while we wait for generation
const silentUrl = (() => {
  const n = 24000; const b = new ArrayBuffer(44 + n * 2); const v = new DataView(b);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, 24000, true); v.setUint32(28, 48000, true);
  v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 2, true);
  return URL.createObjectURL(new Blob([b], { type: 'audio/wav' }));
})();

// ---------- TTS worker ----------
const worker = new Worker('./tts-worker.js', { type: 'module' });
worker.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'progress') {
    setStatus(`Downloading voice model… ${(m.loaded / 1e6).toFixed(0)} / ${(m.total / 1e6).toFixed(0)} MB (one-time)`);
  } else if (m.type === 'ready') {
    ttsReady = true; ttsDevice = m.device;
    setStatus(`Voice engine ready (${m.device === 'webgpu' ? 'GPU' : m.device === 'wasm' ? 'CPU – slower' : m.device})`);
    fill();
  } else if (m.type === 'log') {
    console.warn(m.msg); setStatus(m.msg);
  } else if (m.type === 'fatal') {
    setStatus('Voice engine failed to load: ' + m.msg);
  } else if (m.type === 'audio' || m.type === 'error') {
    const job = pending.get(m.id);
    pending.delete(m.id);
    if (job && job.epoch === epoch && job.key !== 'preview') {
      if (m.type === 'audio') {
        const dur = (m.wav.byteLength - 44) / 48000;
        audio.set(job.key, { url: URL.createObjectURL(new Blob([m.wav], { type: 'audio/wav' })), dur });
        lastGenSpeed = dur / (m.ms / 1000);
      } else {
        console.error(m.msg);
        audio.set(job.key, { failed: true, dur: 0 });
      }
      if (waiting && job.key === key(pos)) playCurrent();
    } else if (job && job.key === 'preview' && m.type === 'audio') {
      const a = new Audio(URL.createObjectURL(new Blob([m.wav], { type: 'audio/wav' })));
      a.playbackRate = settings.rate; a.play();
    }
    fill();
    updateBufferInfo();
  }
};
let lastGenSpeed = 0;
worker.postMessage({ type: 'load', device: settings.device, isMock: MOCK });

function inflight() {
  let n = 0; for (const j of pending.values()) if (j.epoch === epoch && j.key !== 'preview') n++; return n;
}
function isPending(k) { for (const j of pending.values()) if (j.key === k && j.epoch === epoch) return true; return false; }

function fill() {
  if (!book || !ttsReady) return;
  // free audio outside the window
  const lo = step(pos, -1) && step(step(pos, -1), -1) || pos;
  let hi = pos;
  for (let n = 0; n < AHEAD_CHUNKS && hi; n++) { const nx = step(hi); if (!nx) break; hi = nx; }
  for (const [k, v] of audio) {
    const [ch, i] = k.split(':').map(Number);
    const p = { ch, i };
    if (cmp(p, lo) < 0 || cmp(p, hi) > 0) { if (v.url) URL.revokeObjectURL(v.url); audio.delete(k); }
  }
  // request missing chunks in order
  let p = pos;
  for (let n = 0; n <= AHEAD_CHUNKS && p && inflight() < MAX_INFLIGHT; n++, p = step(p)) {
    const k = key(p);
    if (audio.has(k) || isPending(k)) continue;
    const id = ++reqId;
    pending.set(id, { key: k, epoch });
    worker.postMessage({ type: 'gen', id, text: chunksOf(p.ch)[p.i].text, voice: settings.voice });
  }
}

function resetAudio() {
  epoch++;
  worker.postMessage({ type: 'clear' });
  for (const v of audio.values()) if (v.url) URL.revokeObjectURL(v.url);
  audio.clear();
}

// ---------- playback ----------
function playCurrent() {
  if (!book) return;
  const a = audio.get(key(pos));
  renderHighlight();
  saveProgress();
  updateMediaSession();
  if (!playing) return;
  if (!a) {
    waiting = true;
    if (el.src !== silentUrl) { el.loop = true; el.src = silentUrl; el.play().catch(() => {}); }
    setStatus(ttsReady ? 'Generating…' : 'Loading voice engine…');
    fill();
    return;
  }
  waiting = false;
  if (a.failed) { return next(); }
  el.loop = false;
  el.src = a.url;
  el.defaultPlaybackRate = settings.rate;
  el.playbackRate = settings.rate;
  el.play().catch((e) => console.warn(e));
  fill();
  updateBufferInfo();
}

function next() {
  const n = step(pos);
  if (!n) { playing = false; el.pause(); updatePlayBtn(); setStatus(book.id.startsWith('wn:') ? 'End of grabbed chapters. ☰ → "Get more chapters"' : 'End of book 🎉'); return; }
  const chapterChanged = n.ch !== pos.ch;
  pos = n;
  if (chapterChanged) renderChapter();
  playCurrent();
}

el.addEventListener('ended', () => { if (!waiting) next(); });

function play() {
  if (!book) return;
  playing = true; updatePlayBtn();
  if (waiting || !el.src || el.src === silentUrl || el.ended) playCurrent();
  else el.play().catch(() => playCurrent());
}
function pause() {
  playing = false; waiting = false; el.pause(); updatePlayBtn();
}
function jump(p) {
  const chapterChanged = !book || p.ch !== pos.ch;
  pos = p;
  worker.postMessage({ type: 'clear' });
  for (const [id, j] of pending) if (j.key !== 'preview') pending.delete(id); // queued jobs dropped; in-flight results arrive harmlessly
  if (chapterChanged) renderChapter();
  if (playing) { el.pause(); playCurrent(); } else { renderHighlight(); saveProgress(); fill(); }
}
function skip(dir) { const p = step(pos, dir); if (p) jump(p); }
function goChapter(ch) { if (ch >= 0 && ch < book.chapters.length) jump({ ch, i: 0 }); }

// ---------- media session (lock screen / headphones) ----------
function updateMediaSession() {
  if (!('mediaSession' in navigator) || !book) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: book.chapters[pos.ch].title,
    artist: book.title,
    album: `Chapter ${pos.ch + 1} of ${book.chapters.length}`,
    artwork: [{ src: 'icon-512.png', sizes: '512x512', type: 'image/png' }],
  });
}
if ('mediaSession' in navigator) {
  const ms = navigator.mediaSession;
  const h = (a, f) => { try { ms.setActionHandler(a, f); } catch {} };
  h('play', play);
  h('pause', pause);
  h('stop', pause);
  h('previoustrack', () => skip(-1));
  h('nexttrack', () => skip(1));
  h('seekbackward', () => skip(-1));
  h('seekforward', () => skip(1));
}

// ---------- UI ----------
function setStatus(s) { $('#status').textContent = s; }
function updatePlayBtn() {
  $('#play').textContent = playing ? '⏸' : '▶';
  $('#play').setAttribute('aria-label', playing ? 'Pause' : 'Play');
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
}
function updateBufferInfo() {
  if (!book) return;
  let secs = 0; let p = pos;
  while (p) { const a = audio.get(key(p)); if (!a) break; secs += a.dur; p = step(p); }
  const m = Math.floor(secs / settings.rate / 60), s = Math.floor((secs / settings.rate) % 60);
  const dev = ttsDevice === 'webgpu' ? 'GPU' : ttsDevice === 'wasm' ? 'CPU' : ttsDevice;
  if (ttsReady && !waiting) setStatus(`${dev} · ${m}:${String(s).padStart(2, '0')} ready ahead${lastGenSpeed ? ` · ${lastGenSpeed.toFixed(1)}× realtime` : ''}`);
}

let followUntil = 0;
function renderChapter() {
  const c = book.chapters[pos.ch];
  $('#chapter-title').textContent = c.title;
  $('#chapter-num').textContent = `${pos.ch + 1} / ${book.chapters.length}`;
  const t = $('#text');
  t.innerHTML = '';
  const h = document.createElement('h2'); h.textContent = c.title; h.dataset.p = -1; t.appendChild(h);
  const frag = document.createDocumentFragment();
  c.paras.forEach((para, i) => { const p = document.createElement('p'); p.textContent = para; p.dataset.p = i; frag.appendChild(p); });
  t.appendChild(frag);
  t.scrollTop = 0;
  followUntil = 0;
}
function renderHighlight() {
  const c = chunksOf(pos.ch)[pos.i];
  document.querySelectorAll('#text .hl').forEach((n) => n.classList.remove('hl'));
  let first = null;
  for (let p = c.p0; p <= c.p1; p++) {
    const n = $(`#text [data-p="${p}"]`);
    if (n) { n.classList.add('hl'); first = first || n; }
  }
  if (first && Date.now() > followUntil) first.scrollIntoView({ block: 'center', behavior: 'smooth' });
}
$('#text').addEventListener('wheel', () => { followUntil = Date.now() + 8000; }, { passive: true });
$('#text').addEventListener('touchmove', () => { followUntil = Date.now() + 8000; }, { passive: true });
$('#text').addEventListener('click', (e) => {
  const n = e.target.closest('[data-p]');
  if (!n || !book) return;
  const p = Number(n.dataset.p);
  const chunks = chunksOf(pos.ch);
  const i = chunks.findIndex((c) => p >= c.p0 && p <= c.p1);
  if (i >= 0) { followUntil = 0; jump({ ch: pos.ch, i }); if (!playing) play(); }
});

function saveProgress() { if (book) store.set('pos:' + book.id, pos); }

async function openBook(id) {
  const b = await getBook(id);
  if (!b) return;
  pause();
  resetAudio();
  chunkCache.clear();
  book = b;
  store.set('currentBook', id);
  const saved = store.get('pos:' + id, { ch: 0, i: 0 });
  pos = { ch: Math.min(saved.ch, b.chapters.length - 1), i: 0 };
  pos.i = Math.min(saved.i, chunksOf(pos.ch).length - 1);
  $('#book-title').textContent = b.title;
  document.body.classList.add('has-book');
  renderChapter();
  renderHighlight();
  renderChapterList();
  updateMoreLink();
  closePanels();
  updateMediaSession();
  fill();
}

function renderChapterList(filter = '') {
  const ul = $('#chapter-list');
  ul.innerHTML = '';
  const f = filter.trim().toLowerCase();
  const frag = document.createDocumentFragment();
  book.chapters.forEach((c, i) => {
    if (f && !(`${i + 1} ${c.title}`.toLowerCase().includes(f))) return;
    const li = document.createElement('li');
    li.innerHTML = `<span class="n">${i + 1}</span><span class="t"></span>`;
    li.querySelector('.t').textContent = c.title;
    if (i === pos.ch) li.classList.add('current');
    li.onclick = () => { goChapter(i); closePanels(); };
    frag.appendChild(li);
  });
  ul.appendChild(frag);
}

async function renderLibrary() {
  const books = await listBooks();
  const ul = $('#library-list');
  ul.innerHTML = books.length ? '' : '<li class="empty">No books yet. Import an EPUB above.</li>';
  for (const b of books) {
    const li = document.createElement('li');
    li.innerHTML = `<div class="bt"></div><div class="ba"></div><button class="del" aria-label="Delete">🗑</button>`;
    li.querySelector('.bt').textContent = b.title;
    li.querySelector('.ba').textContent = `${b.author ? b.author + ' · ' : ''}${b.n} chapters`;
    li.onclick = (e) => { if (!e.target.closest('.del')) openBook(b.id); };
    li.querySelector('.del').onclick = async () => {
      if (!confirm(`Delete "${b.title}" from this device?`)) return;
      await deleteBook(b.id);
      if (book && book.id === b.id) { book = null; document.body.classList.remove('has-book'); store.set('currentBook', null); pause(); }
      renderLibrary();
    };
    ul.appendChild(li);
  }
}

$('#file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const msg = $('#import-msg');
  try {
    msg.textContent = 'Reading book…';
    const parsed = /\.epub$/i.test(file.name)
      ? await parseEpub(file, (f) => { msg.textContent = `Reading book… ${Math.round(f * 100)}%`; })
      : await parseTxt(file);
    if (!parsed.chapters.length) throw new Error('No chapters found');
    const id = `${parsed.title}|${parsed.chapters.length}`;
    await saveBook({ id, ...parsed, added: Date.now() });
    msg.textContent = `Imported ${parsed.chapters.length} chapters.`;
    await renderLibrary();
    openBook(id);
  } catch (err) {
    console.error(err);
    msg.textContent = 'Could not read that file: ' + err.message;
  }
  e.target.value = '';
});

// panels
function closePanels() { document.querySelectorAll('.panel').forEach((p) => p.classList.remove('open')); }
function openPanel(id) { closePanels(); $(id).classList.add('open'); }
$('#btn-library').onclick = () => { renderLibrary(); openPanel('#library'); };
$('#btn-chapters').onclick = () => { if (!book) return; renderChapterList($('#chapter-filter').value); openPanel('#chapters'); const c = $('#chapter-list .current'); if (c) c.scrollIntoView({ block: 'center' }); };
$('#btn-settings').onclick = () => openPanel('#settings');
document.querySelectorAll('.panel .close').forEach((b) => (b.onclick = closePanels));
$('#chapter-filter').addEventListener('input', (e) => renderChapterList(e.target.value));
$('#chapter-go').addEventListener('submit', (e) => {
  e.preventDefault();
  const n = parseInt($('#chapter-filter').value, 10);
  if (n >= 1 && n <= book.chapters.length) { goChapter(n - 1); closePanels(); }
});

// transport
$('#play').onclick = () => (playing ? pause() : play());
$('#back').onclick = () => skip(-1);
$('#fwd').onclick = () => skip(1);
$('#prev-ch').onclick = () => goChapter(pos.i > 1 ? pos.ch : pos.ch - 1);
$('#next-ch').onclick = () => goChapter(pos.ch + 1);

// settings
const voiceSel = $('#voice');
for (const [id, name] of VOICES) { const o = document.createElement('option'); o.value = id; o.textContent = name; voiceSel.appendChild(o); }
voiceSel.value = settings.voice;
voiceSel.onchange = () => {
  settings.voice = voiceSel.value; store.set('voice', settings.voice);
  resetAudio(); if (playing) { el.pause(); playCurrent(); } else fill();
};
$('#preview').onclick = () => {
  if (!ttsReady) return setStatus('Voice engine still loading…');
  const id = ++reqId; pending.set(id, { key: 'preview', epoch });
  worker.postMessage({ type: 'gen', id, voice: settings.voice, text: 'The ancient sword hummed in his hand. "So this is the power of the heavens," he whispered, as the sky split open above him.' });
};
const rateSel = $('#rate');
const rateLbl = $('#rate-val');
const showRate = () => { rateLbl.textContent = settings.rate.toFixed(2) + '×'; $('#speed-btn').textContent = settings.rate.toFixed(2).replace(/0$/, '') + '×'; };
rateSel.value = settings.rate; showRate();
rateSel.oninput = () => { settings.rate = Number(rateSel.value); store.set('rate', settings.rate); el.playbackRate = settings.rate; el.defaultPlaybackRate = settings.rate; showRate(); updateBufferInfo(); };
$('#speed-btn').onclick = () => {
  const steps = [1, 1.15, 1.25, 1.4, 1.5, 1.75, 2];
  const i = steps.findIndex((s) => s > settings.rate + 0.01);
  settings.rate = i === -1 ? steps[0] : steps[i];
  rateSel.value = settings.rate; rateSel.oninput();
};
const devSel = $('#device');
devSel.value = settings.device;
devSel.onchange = () => { store.set('device', devSel.value); location.reload(); };

// keyboard (desktop)
document.addEventListener('keydown', (e) => {
  if (e.target.matches('input,select,textarea')) return;
  if (e.code === 'Space') { e.preventDefault(); playing ? pause() : play(); }
  if (e.code === 'ArrowLeft') skip(-1);
  if (e.code === 'ArrowRight') skip(1);
});

// ---------- boot ----------
if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
if ('serviceWorker' in navigator && !MOCK && location.protocol === 'https:') navigator.serviceWorker.register('./sw.js');
setStatus(MOCK ? 'Mock voice (testing mode)' : 'Loading voice engine…');
// ---------- bookmarklet installer ----------
const APP_URL = location.origin + location.pathname.replace(/[^/]*$/, '');
async function buildBookmarklet() {
  const src = await (await fetch('grab.js', { cache: 'no-cache' })).text();
  const code = src.replace(/^\s*\/\*[\s\S]*?\*\/\s*/, '').replace('__APP_URL__', APP_URL);
  return 'javascript:' + encodeURIComponent(code);
}
$('#bm-card').addEventListener('toggle', async (e) => {
  if (e.target.open && !$('#bm-code').value) $('#bm-code').value = await buildBookmarklet();
});
$('#copy-bm').onclick = async () => {
  const code = $('#bm-code').value || (await buildBookmarklet());
  $('#bm-code').value = code;
  try { await navigator.clipboard.writeText(code); $('#copy-msg').textContent = ' Copied ✓'; }
  catch { $('#bm-code').select(); document.execCommand('copy'); $('#copy-msg').textContent = ' Copied (select-all fallback)'; }
};
function updateMoreLink() {
  const a = $('#more-chapters');
  const m = book && book.id.match(/^wn:(\d+)$/);
  if (!m) { a.classList.add('hidden'); return; }
  const last = book.chapters[book.chapters.length - 1];
  a.href = `https://www.webnovel.com/book/${m[1]}/${last.id}`;
  a.classList.remove('hidden');
}

// ---------- receive chapters from the webnovel bookmarklet ----------
function validPayload(d) {
  return d && d.type === 'wn-chapters' && d.book && typeof d.book.id === 'string' && Array.isArray(d.chapters) &&
    d.chapters.every((c) => c && typeof c.title === 'string' && Array.isArray(c.paras) && c.paras.every((p) => typeof p === 'string'));
}
async function importChapters(d) {
  const id = d.book.id;
  const existing = await getBook(id);
  const chapters = existing ? existing.chapters.slice() : [];
  const byId = new Map(chapters.map((c, i) => [String(c.id), i]));
  for (const c of d.chapters) {
    const ch = { id: String(c.id), index: c.index, title: c.title, paras: c.paras };
    if (byId.has(ch.id)) chapters[byId.get(ch.id)] = ch;
    else { byId.set(ch.id, chapters.length); chapters.push(ch); }
  }
  if (chapters.every((c) => typeof c.index === 'number')) chapters.sort((a, b) => a.index - b.index);
  await saveBook({ id, title: d.book.title, author: existing?.author || '', source: d.book.source, chapters, added: existing?.added || Date.now() });
  const first = chapters.findIndex((c) => c.id === String(d.chapters[0].id));
  store.set('pos:' + id, { ch: Math.max(0, first), i: 0 });
  await openBook(id);
  setStatus(`Added ${d.chapters.length} chapter(s) · tap ▶ to listen`);
}

(async () => {
  const host = window.opener || (window.parent !== window ? window.parent : null);
  if (params.has('import') && host) {
    setStatus('Waiting for chapters…');
    let got = false;
    window.addEventListener('message', async (e) => {
      if (got || e.source !== host || !validPayload(e.data)) return;
      got = true;
      await importChapters(e.data);
      if (!EMBED) history.replaceState(null, '', location.pathname);
    });
    for (let k = 0; k < 40 && !got; k++) { host.postMessage({ type: 'wn-ready' }, '*'); await new Promise((r) => setTimeout(r, 500)); }
    if (got) return;
  }
  const cur = store.get('currentBook', null);
  if (cur && (await getBook(cur))) openBook(cur);
  else { renderLibrary(); openPanel('#library'); }
})();

// expose for debugging/tests
window.__app = { get pos() { return pos; }, get playing() { return playing; }, audio, chunksOf, get book() { return book; } };
