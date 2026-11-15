import { parseEpub, parseTxt } from './epub.js';
import { Tape, tapeSupported } from './tape.js';

const $ = (s) => document.querySelector(s);
const params = new URLSearchParams(location.search);
const MOCK = params.has('mock');
const EMBED = params.has('embed');
if (EMBED) document.documentElement.classList.add('embed');

const VOICES = [
  ['af_heart', 'Heart (US, female), recommended'],
  ['af_bella', 'Bella (US, female), recommended'],
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
const AHEAD_CHUNKS = 60;   // passages kept loaded in memory ahead of the reading position
const URGENT_SECS = 90;      // below this much listening time ready, the engine runs flat out
// GPU use: after each passage the engine rests for (passage work time × factor).
// 2.5 means the GPU works ~30% of the time; 0 means flat out.
const PACE = { gentle: { relaxed: 2.5, prep: 1 }, balanced: { relaxed: 1, prep: 0.4 }, fast: { relaxed: 0, prep: 0 } };
const MAX_INFLIGHT = 2;
const CHUNK_VER = 2;       // bump when buildChunks() changes, so saved audio is regenerated

// ---------- settings ----------
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const settings = {
  voice: store.get('voice', 'af_heart'),
  rate: store.get('rate', 1.0),
  device: store.get('device', 'auto'),
  gpu: store.get('gpu', 'gentle'),
  aheadMin: store.get('aheadMin', 30), // keep this many minutes saved ahead while listening
};
const aheadTarget = () => settings.aheadMin * 60 * settings.rate; // in audio seconds

// ---------- IndexedDB ----------
let dbp = null;
function db() {
  return dbp || (dbp = new Promise((res, rej) => {
    const r = indexedDB.open('novel-tts', 2);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains('books')) d.createObjectStore('books', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('audio')) d.createObjectStore('audio', { keyPath: 'k' }).createIndex('book', 'book');
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
}
async function idb(name, mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const tx = d.transaction(name, mode);
    const req = fn(tx.objectStore(name));
    tx.oncomplete = () => res(req && req.result);
    tx.onerror = () => rej(tx.error);
    tx.onabort = () => rej(tx.error);
  });
}
const saveBook = (b) => idb('books', 'readwrite', (s) => s.put(b));
const getBook = (id) => idb('books', 'readonly', (s) => s.get(id));
const listBooks = async () => {
  const all = await idb('books', 'readonly', (s) => s.getAll());
  return (all || []).map((b) => ({ id: b.id, title: b.title, author: b.author, n: b.chapters.length }));
};
const putAudio = (rec) => idb('audio', 'readwrite', (s) => s.put(rec));
const getAudio = (k) => idb('audio', 'readonly', (s) => s.get(k));
const audioMeta = (bookId) => idb('audio', 'readonly', (s) => s.index('book').getAll(IDBKeyRange.only(bookId)));
async function deleteAudioWhere(bookId, pred) {
  const d = await db();
  return new Promise((res, rej) => {
    const tx = d.transaction('audio', 'readwrite');
    const cur = tx.objectStore('audio').index('book').openCursor(IDBKeyRange.only(bookId));
    let n = 0;
    cur.onsuccess = () => { const c = cur.result; if (!c) return; if (pred(c.value)) { c.delete(); n++; } c.continue(); };
    tx.oncomplete = () => res(n);
    tx.onerror = () => rej(tx.error);
  });
}
async function deleteBook(id) {
  await idb('books', 'readwrite', (s) => s.delete(id));
  await deleteAudioWhere(id, () => true);
}

// ---------- text -> speakable chunks ----------
function speakable(s) {
  return s
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[【〖「『\[<{]/g, ' ')
    .replace(/[】〗」』\]>}]/g, ', ')
    .replace(/…/g, '...')
    .replace(/\s*[—–]+\s*/g, ', ')            // dashes -> short pause
    .replace(/(^|\s)-{2,}(\s|$)/g, ', ')
    .replace(/[~*_=#|^]+/g, ' ')
    .replace(/\.\s*\./g, '.').replace(/(\.\s*){2,}/g, '... ')
    .replace(/([!?])[!?]{2,}/g, '$1')          // "?!!!" -> "?"
    .replace(/!{2,}/g, '!').replace(/\?{2,}/g, '?')
    .replace(/([A-Za-z])\1{3,}/g, '$1$1$1')      // "Ahhhhhhh" -> "Ahhh"
    .replace(/\b[A-Z][A-Z']{3,}\b/g, (w) => w[0] + w.slice(1).toLowerCase()) // SHOUTING isn't spelled out
    .replace(/\bLv\.\s*/g, 'Level ')
    .replace(/(^|[\s(])x(\d+)\b/g, '$1times $2')
    .replace(/,\s*([,.!?])/g, '$1').replace(/^[,\s]+/, '').replace(/\s*,\s*,/g, ',')
    .replace(/\s+/g, ' ')
    .trim();
}
const hasWords = (s) => /[A-Za-z0-9]/.test(s);

function splitLong(s, max) {
  if (s.length <= max) return [s];
  const out = [];
  let rest = s;
  while (rest.length > max) {
    let cut = Math.max(rest.lastIndexOf(', ', max), rest.lastIndexOf('; ', max), rest.lastIndexOf(': ', max));
    if (cut < max * 0.4) cut = rest.lastIndexOf(' ', max);
    if (cut <= 0) cut = max;
    out.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1).trim();
  }
  if (rest) out.push(rest);
  return out;
}

// One chunk never spans two paragraphs, so every paragraph (and every line
// of dialogue) ends with a real pause. `pad` is the silence added after it, in ms.
const PAUSE = { title: 800, para: 450, dialogue: 380, sentence: 140 };
function buildChunks(chapter) {
  const MAX = 260;
  const chunks = [{ text: speakable(chapter.title).replace(/[.!?,]*$/, '.'), p0: -1, p1: -1, pad: PAUSE.title }];
  chapter.paras.forEach((para, pi) => {
    const t = speakable(para);
    if (!hasWords(t)) return;
    const sentences = t.match(/[^.!?]+(?:[.!?]+["'”’)]*|$)\s*/g) || [t];
    const pieces = [];
    let cur = '';
    for (let s of sentences) {
      s = s.trim();
      if (!s) continue;
      for (const piece of splitLong(s, MAX)) {
        if (cur && cur.length + piece.length + 1 > MAX) { pieces.push(cur); cur = ''; }
        cur = cur ? cur + ' ' + piece : piece;
      }
    }
    if (cur) pieces.push(cur);
    const isDialogue = /^["“'‘]/.test(t);
    pieces.forEach((text, k) => {
      if (!hasWords(text)) return;
      const last = k === pieces.length - 1;
      chunks.push({ text, p0: pi, p1: pi, pad: last ? (isDialogue ? PAUSE.dialogue : PAUSE.para) : PAUSE.sentence });
    });
  });
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
const mem = new Map();        // audio key -> {url, dur, ch, i, failed}
const stored = new Map();     // audio key -> dur, for everything saved on the phone for this book
const lookups = new Set();    // audio keys being read from IndexedDB
const pending = new Map();    // reqId -> {k, ch, i, voice, bookId} | {preview:true}
let reqId = 0;
let lastGenSpeed = 0;
let prep = null;              // {from, to, total} chapters being prepared
let curUrl = null;            // blob url currently in the <audio> element

const el = $('#player');
const chunksOf = (ch) => {
  if (!chunkCache.has(ch)) chunkCache.set(ch, buildChunks(book.chapters[ch]));
  return chunkCache.get(ch);
};
const chId = (ch) => { const c = book.chapters[ch]; return c.id != null ? String(c.id) : String(ch); };
const SEP = '\u241E'; // separator that never appears in book/chapter ids
const akey = (p, voice = settings.voice) => [book.id, voice, CHUNK_VER, chId(p.ch), p.i].join(SEP);
const keyCh = (k) => k.split(SEP)[3];
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
let worker = null;
let lastPace = -1; // last rest factor sent to the engine
const genErrors = new Map(); // audio key -> failures; a passage is only skipped after 3
const onWorkerMessage = (e) => {
  const m = e.data;
  if (m.type === 'progress') {
    setStatus(`Downloading voice model… ${(m.loaded / 1e6).toFixed(0)} / ${(m.total / 1e6).toFixed(0)} MB (one-time)`);
  } else if (m.type === 'ready') {
    ttsReady = true; ttsDevice = m.device;
    setStatus(`Voice engine ready (${devName()})`);
    fill();
  } else if (m.type === 'log') {
    console.warn(m.msg);
  } else if (m.type === 'fatal') {
    setStatus('Voice engine failed to load: ' + m.msg);
  } else if (m.type === 'audio' || m.type === 'error') {
    const job = pending.get(m.id);
    pending.delete(m.id);
    if (!job) return;
    if (job.preview) {
      if (m.type === 'audio') { const a = new Audio(URL.createObjectURL(m.blob)); a.playbackRate = settings.rate; a.play(); }
      return;
    }
    if (m.type === 'audio') {
      lastGenSpeed = m.dur / (m.ms / 1000);
      if (document.hidden) away.made += m.dur;
      putAudio({ k: job.k, book: job.bookId, ch: job.ch, i: job.i, voice: job.voice, dur: m.dur, blob: m.blob })
        .catch((err) => { console.warn('could not save audio', err); setStatus('Phone storage full? Could not save audio.'); });
      if (book && book.id === job.bookId) {
        stored.set(job.k, m.dur);
        if (inWindow(job)) mem.set(job.k, { url: URL.createObjectURL(m.blob), blob: m.blob, dur: m.dur, ch: job.ch, i: job.i });
      }
    } else {
      console.error(m.msg);
      const n = (genErrors.get(job.k) || 0) + 1;
      genErrors.set(job.k, n);
      if (document.hidden) logAway('voice engine error: ' + String(m.msg).slice(0, 80));
      // a GPU hiccup (e.g. while the screen turns off) is retried; only a passage that keeps failing is skipped
      if (n >= 3 && book && book.id === job.bookId) mem.set(job.k, { failed: true, dur: 0, ch: job.ch, i: job.i });
    }
    if (waiting && book && job.k === akey(pos)) playCurrent();
    if (tape && tape.active) tape.pump();
    fill();
    updateInfo();
  } else if (m.type === 'dropped') {
    for (const id of m.ids) pending.delete(id);
    fill();
  }
};
function startWorker() {
  worker = new Worker('./tts-worker.js', { type: 'module' });
  worker.onmessage = onWorkerMessage;
  lastPace = -1;
  worker.postMessage({ type: 'load', device: settings.device, isMock: MOCK });
}
startWorker();
// Watchdog: if the engine hangs on a passage (it can happen when the GPU is
// taken away, e.g. as the screen turns off), restart it instead of waiting forever.
setInterval(() => {
  if (!ttsReady || retired) return;
  let oldest = Infinity;
  for (const j of pending.values()) if (!j.preview && j.t) oldest = Math.min(oldest, j.t);
  if (Date.now() - oldest < 90000) return;
  logAway('voice engine stuck, restarted');
  console.warn('voice engine stuck, restarting');
  worker.terminate();
  pending.clear();
  ttsReady = false;
  startWorker();
}, 15000);
const devName = () => (ttsDevice === 'webgpu' ? 'GPU' : ttsDevice === 'wasm' ? 'CPU – slower' : ttsDevice);

const genInflight = () => { let n = 0; for (const j of pending.values()) if (!j.preview) n++; return n; };
const isPending = (k) => { for (const j of pending.values()) if (j.k === k) return true; return false; };
function windowBounds() {
  const lo = step(pos, -1) || pos;
  let hi = pos;
  for (let n = 0; n < AHEAD_CHUNKS; n++) { const nx = step(hi); if (!nx) break; hi = nx; }
  return { lo, hi };
}
let bounds = null;
const inWindow = (p) => bounds && cmp(p, bounds.lo) >= 0 && cmp(p, bounds.hi) <= 0;

function requestGen(p) {
  const k = akey(p);
  const id = ++reqId;
  pending.set(id, { k, ch: p.ch, i: p.i, voice: settings.voice, bookId: book.id, t: Date.now() });
  worker.postMessage({ type: 'gen', id, text: chunksOf(p.ch)[p.i].text, voice: settings.voice, pad: chunksOf(p.ch)[p.i].pad });
}

function secsAhead() {
  let secs = 0, p = pos;
  while (p) { const d = stored.get(akey(p)); if (d == null) break; secs += d; p = step(p); }
  return secs;
}

// Keeps memory loaded around the reading position, and asks the worker for
// whatever audio is missing. Saved audio always wins over generating.
function fill() {
  if (!book) return;
  bounds = windowBounds();
  const cur = akey(pos);
  for (const [k, v] of mem) {
    if (k === cur) continue;
    if (!k.startsWith(book.id + SEP + settings.voice + SEP) || !inWindow(v)) {
      if (v.url && v.url !== curUrl) URL.revokeObjectURL(v.url);
      mem.delete(k);
    }
  }
  // 1) load saved audio from the phone into memory
  let p = pos;
  for (let n = 0; n <= AHEAD_CHUNKS && p; n++, p = step(p)) {
    const k = akey(p);
    if (mem.has(k) || lookups.has(k) || !stored.has(k)) continue;
    if (lookups.size >= 6) break;
    lookups.add(k);
    const q = p, bookId = book.id;
    getAudio(k).then((r) => {
      lookups.delete(k);
      if (!book || book.id !== bookId) return;
      if (r && r.blob) mem.set(k, { url: URL.createObjectURL(r.blob), blob: r.blob, dur: r.dur, ch: q.ch, i: q.i });
      else stored.delete(k);
      if (waiting && k === akey(pos)) playCurrent();
      if (tape && tape.active) tape.pump();
      fill();
    }).catch(() => { lookups.delete(k); stored.delete(k); fill(); });
  }
  if (!ttsReady) return;
  // 2) generate what's missing right ahead of the listener
  let ahead = 0;
  p = pos;
  for (let n = 0; n <= 3000 && p && genInflight() < MAX_INFLIGHT; n++, p = step(p)) {
    const k = akey(p);
    const d = stored.get(k);
    if (d != null) { ahead += d; continue; }
    if (mem.has(k) || isPending(k)) { ahead += 15; continue; }
    if (!playing && !prep && n > 3) break;           // idle: only warm up the first few
    if (ahead > aheadTarget() && !prep) break;       // far enough ahead: the GPU rests completely
    requestGen(p);
  }
  // 3) "Prepare chapters": keep generating everything in the chosen range
  if (prep && genInflight() < MAX_INFLIGHT) {
    let q = { ch: Math.max(prep.from, pos.ch), i: 0 };
    if (q.ch === pos.ch) q = { ...pos };
    for (; q && q.ch <= prep.to && genInflight() < MAX_INFLIGHT; q = step(q)) {
      const k = akey(q);
      if (stored.has(k) || isPending(k) || mem.has(k)) continue;
      requestGen(q);
    }
    if (!q || q.ch > prep.to) { if (!genInflight()) finishPrepare(); }
  }
  setPace();
}

// Tell the engine how hard to work: flat out when the listener is about to run
// out of audio, otherwise with rests in between so the GPU stays cool.
function setPace() {
  const ahead = secsAhead() / settings.rate;
  const prof = PACE[settings.gpu] || PACE.gentle;
  const f = ahead < URGENT_SECS && playing ? 0 : prep ? prof.prep : prof.relaxed;
  if (f !== lastPace) { lastPace = f; worker.postMessage({ type: 'pace', factor: f }); }
}

function resetMem() {
  for (const v of mem.values()) if (v.url && v.url !== curUrl) URL.revokeObjectURL(v.url);
  mem.clear();
}
function dropQueued() { worker.postMessage({ type: 'clear' }); }

// ---------- playback ----------
// Preferred: one continuous stream (tape.js) so Chrome never sees playback stop
// between passages, even in the background. Fallback: one file per passage.
let tape = null;
if (tapeSupported() && !params.has('notape')) {
  tape = new Tape(el, {
    async getAudio(p) {
      if (!book) return null;
      const k = akey(p);
      const m = mem.get(k);
      if (m && m.failed) return 'skip';
      let blob = m && m.blob;
      if (!blob && stored.has(k)) { try { blob = (await getAudio(k))?.blob; } catch {} }
      if (blob && !/ogg/.test(blob.type)) { useFileMode(); return null; }
      return blob || null;
    },
    next: (p) => step(p),
    onPos(p) {
      if (!book || cmp(p, pos) === 0) return;
      const chapterChanged = p.ch !== pos.ch;
      pos = p;
      if (chapterChanged) { renderChapter(); cleanupOldAudio(); updateMediaSession(); }
      renderHighlight();
      saveProgress();
      fill();
      updateInfo();
    },
    onEnd() { if (playing) endReached(); },
    onError(e) { console.warn('stream failed, switching to file-by-file playback', e); useFileMode(); if (playing) { playing = false; play(); } },
  });
}
function useFileMode() { if (tape) { tape.stop(); tape = null; } }
function endReached() {
  playing = false; el.pause(); updatePlayBtn();
  setStatus(book.source ? 'End of the grabbed chapters. Open Chapters to get more.' : 'End of the book.');
}
el.addEventListener('waiting', () => {
  if (!tape || !playing) return;
  if (document.hidden) { away.stalls++; logAway(`ran out of audio (${Math.round(secsAhead())} s saved ahead)`); }
  setStatus(ttsReady ? 'Generating…' : 'Loading voice engine…');
});
el.addEventListener('playing', () => updateInfo());
// If Android pauses the audio by itself while the screen is off, note it and try to resume once.
el.addEventListener('pause', () => {
  if (!playing || !document.hidden || retired) return;
  logAway('the phone paused the audio');
  if (away.resumed++ < 2) el.play().then(() => logAway('resumed'), (e) => logAway('could not resume: ' + e.name));
});
el.addEventListener('error', () => { if (document.hidden) logAway('audio error: ' + (el.error && el.error.message)); });

function playCurrent() {
  if (!book) return;
  const a = mem.get(akey(pos));
  renderHighlight();
  saveProgress();
  updateMediaSession();
  if (!playing) return;
  if (!a) {
    if (document.hidden && !waiting) away.stalls++;
    waiting = true;
    if (el.src !== silentUrl) { el.loop = true; el.src = silentUrl; el.play().catch(() => {}); }
    setStatus(ttsReady || stored.has(akey(pos)) ? 'Generating…' : 'Loading voice engine…');
    fill();
    return;
  }
  waiting = false;
  if (a.failed) { return next(); }
  el.loop = false;
  const old = curUrl;
  curUrl = a.url;
  el.src = a.url;
  if (old && old !== a.url && ![...mem.values()].some((v) => v.url === old)) URL.revokeObjectURL(old);
  el.defaultPlaybackRate = settings.rate;
  el.playbackRate = settings.rate;
  el.play().catch((e) => console.warn(e));
  fill();
  updateInfo();
}

function next() {
  const n = step(pos);
  if (!n) { endReached(); return; }
  const chapterChanged = n.ch !== pos.ch;
  pos = n;
  if (chapterChanged) { renderChapter(); cleanupOldAudio(); }
  playCurrent();
}

el.addEventListener('ended', () => { if (tape) return; if (document.hidden) away.played += el.duration || 0; if (!waiting) next(); });

async function play() {
  if (!book) return;
  playing = true; updatePlayBtn();
  if (tape) {
    if (!tape.active) await tape.start(pos);
    el.defaultPlaybackRate = settings.rate; el.playbackRate = settings.rate;
    renderHighlight(); updateMediaSession();
    el.play().catch((e) => console.warn(e));
    fill();
    return;
  }
  if (waiting || !el.src || el.src === silentUrl || el.ended) playCurrent();
  else el.play().catch(() => playCurrent());
}
function pause() {
  playing = false; waiting = false; el.pause(); updatePlayBtn(); updateInfo();
}
function jump(p) {
  const chapterChanged = !book || p.ch !== pos.ch;
  pos = p;
  dropQueued();
  if (chapterChanged) renderChapter();
  if (tape) {
    el.pause();
    tape.stop();
    renderHighlight(); saveProgress(); fill();
    if (playing) play();
    return;
  }
  if (playing) { el.pause(); playCurrent(); } else { renderHighlight(); saveProgress(); fill(); }
}
function skip(dir) { const p = step(pos, dir); if (p) jump(p); }
function goChapter(ch) { if (ch >= 0 && ch < book.chapters.length) jump({ ch, i: 0 }); }

// Saved audio for chapters you finished more than one chapter ago is deleted
// automatically, so storage doesn't grow forever.
function cleanupOldAudio() {
  const keepFrom = pos.ch - 1;
  const ids = new Set(book.chapters.slice(0, Math.max(0, keepFrom)).map((c, i) => (c.id != null ? String(c.id) : String(i))));
  if (!ids.size) return;
  const bookId = book.id;
  deleteAudioWhere(bookId, (r) => ids.has(keyCh(r.k))).then(() => {
    if (!book || book.id !== bookId) return;
    for (const k of [...stored.keys()]) if (ids.has(keyCh(k))) stored.delete(k);
    updateInfo();
  }).catch(() => {});
}

// ---------- prepare chapters for background / offline listening ----------
let wakeLock = null;
async function startPrepare(n) {
  if (!book) return;
  const from = pos.ch, to = Math.min(book.chapters.length - 1, pos.ch + n - 1);
  prep = { from, to, n };
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch {}
  updateInfo();
  fill();
}
function stopPrepare() {
  prep = null;
  try { wakeLock?.release(); } catch {}
  wakeLock = null;
  dropQueued();
  updateInfo();
}
function finishPrepare() {
  const done = prep;
  prep = null;
  try { wakeLock?.release(); } catch {}
  wakeLock = null;
  updateInfo();
  if (done) setStatus(`Chapters ${done.from + 1} to ${done.to + 1} are saved. You can lock the phone.`);
}
// What happened while the screen was off / the app was in the background.
const away = { since: 0, played: 0, made: 0, stalls: 0, wasPlaying: false, events: [], resumed: 0 };
function logAway(what) {
  if (!away.since) return;
  const s = Math.round((Date.now() - away.since) / 1000);
  away.events.push(`${s < 90 ? s + ' s' : Math.round(s / 60) + ' min'}: ${what}`);
  if (away.events.length > 30) away.events.shift();
}
document.addEventListener('visibilitychange', async () => {
  if (document.hidden) {
    Object.assign(away, { since: Date.now(), played: 0, made: 0, stalls: 0, wasPlaying: playing, t0: el.currentTime, events: [], resumed: 0 });
    // Queue as much saved audio as possible straight into the player, so it can
    // keep going for a long time even if Chrome barely runs our code.
    if (tape && tape.active) { tape.aheadSecs = 40 * 60; tape.pump(); }
    return;
  }
  if (tape) tape.aheadSecs = 240;
  if (prep && !wakeLock) { try { wakeLock = await navigator.wakeLock?.request('screen'); } catch {} }
  const gone = (Date.now() - away.since) / 1000;
  if (tape && tape.active) away.played = Math.max(0, el.currentTime - away.t0);
  if (away.since && away.wasPlaying && gone > 20) {
    const m = (x) => (x < 90 ? `${Math.round(x)} s` : `${Math.round(x / 60)} min`);
    const msg = `While away (${m(gone)}): played ${m(away.played / settings.rate)}, made ${m(away.made)} of new audio` +
      (away.stalls ? `, ran out ${away.stalls} time${away.stalls > 1 ? 's' : ''}` : ', never ran out') +
      (away.events.length ? '. Details in Settings.' : '');
    setStatus(msg);
    store.set('lastAway', { at: Date.now(), msg, events: away.events.slice() });
    showAwayLog();
    clearTimeout(updateInfo.t); infoT = Date.now() + 8000; // keep the message up for a few seconds
  }
  away.since = 0;
});
function prepStats() {
  // how many chapters from the current one are fully saved, and how long they last
  let readyCh = 0, secs = secsAhead();
  for (let ch = pos.ch; ch < book.chapters.length; ch++) {
    const cs = chunksOf(ch);
    let all = true;
    for (let i = ch === pos.ch ? pos.i : 0; i < cs.length; i++) if (!stored.has(akey({ ch, i }))) { all = false; break; }
    if (!all) break;
    readyCh++;
  }
  let prepPct = 0;
  if (prep) {
    let tot = 0, have = 0;
    for (let ch = prep.from; ch <= prep.to; ch++) { const cs = chunksOf(ch); tot += cs.length; for (let i = 0; i < cs.length; i++) if (stored.has(akey({ ch, i }))) have++; }
    prepPct = tot ? have / tot : 1;
  }
  return { readyCh, secs, prepPct };
}
const fmtTime = (secs) => {
  const s = Math.round(secs / settings.rate);
  if (s >= 3600) return `${Math.floor(s / 3600)} h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')} min`;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

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
  h('pause', () => { if (document.hidden) logAway('pause from lock screen, headphones or the phone'); pause(); });
  h('stop', pause);
  h('previoustrack', () => skip(-1));
  h('nexttrack', () => skip(1));
  h('seekbackward', () => skip(-1));
  h('seekforward', () => skip(1));
}

// ---------- UI ----------
function setStatus(s) { $('#status').textContent = s; }
function updatePlayBtn() {
  $('#play use').setAttribute('href', playing ? '#i-pause' : '#i-play');
  $('#play').setAttribute('aria-label', playing ? 'Pause' : 'Play');
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
}
let infoT = 0;
function updateInfo() {
  if (!book || retired) return;
  const now = Date.now();
  if (now - infoT < 250) { clearTimeout(updateInfo.t); updateInfo.t = setTimeout(updateInfo, 260); return; }
  infoT = now;
  const st = prepStats();
  const bits = [];
  if (prep) bits.push(`Saving chapters ${prep.from + 1} to ${prep.to + 1}: ${Math.round(st.prepPct * 100)}%, keep the screen on`);
  else if (ttsReady || st.secs) bits.push(`${fmtTime(st.secs)} ready`);
  if (ttsReady && genInflight() && lastGenSpeed) bits.push(`${devName().split(' ')[0]} at ${lastGenSpeed.toFixed(1)}×`);
  if (!waiting) setStatus(bits.join(', '));
  // screen-off sheet: one figure, its plain label beneath
  const voiceName = (VOICES.find((v) => v[0] === settings.voice) || [0, settings.voice])[1].split(' (')[0];
  $('#off-fig').textContent = fmtTime(st.secs);
  $('#off-ready').textContent = st.readyCh
    ? `saved ahead at ${settings.rate}×: ${st.readyCh} chapter${st.readyCh > 1 ? 's' : ''} in the ${voiceName} voice.`
    : 'saved ahead. Save a few chapters before you lock the phone.';
  $('#off-prog').classList.toggle('hidden', !prep);
  $('#off-stop').classList.toggle('hidden', !prep);
  $('#off-bar').style.transform = `scaleX(${st.prepPct.toFixed(3)})`;
  $('#btn-offline').classList.toggle('busy', !!prep);
  document.querySelectorAll('[data-prep]').forEach((b) => b.classList.toggle('on', !!prep && Number(b.dataset.prep) === prep.n));
}

let followUntil = 0;
function renderChapter() {
  const c = book.chapters[pos.ch];
  $('#chapter-title').textContent = c.title;
  $('#chapter-num').textContent = `${pos.ch + 1} / ${book.chapters.length}`;
  const t = $('#text');
  t.textContent = '';
  const h = document.createElement('h2'); h.textContent = c.title; h.dataset.p = -1; t.appendChild(h);
  const frag = document.createDocumentFragment();
  c.paras.forEach((para, i) => { const p = document.createElement('p'); p.textContent = para; p.dataset.p = i; frag.appendChild(p); });
  t.appendChild(frag);
  t.scrollTop = 0;
  followUntil = 0;
  hlNodes = [];
}
let hlNodes = [];
function renderHighlight() {
  const c = chunksOf(pos.ch)[pos.i];
  const t = $('#text');
  const nodes = [];
  for (let p = c.p0; p <= c.p1; p++) { const n = t.querySelector(`[data-p="${p}"]`); if (n) nodes.push(n); }
  if (nodes.length === hlNodes.length && nodes.every((n, i) => n === hlNodes[i])) return;
  hlNodes.forEach((n) => n.classList.remove('hl'));
  nodes.forEach((n) => n.classList.add('hl'));
  hlNodes = nodes;
  const first = nodes[0];
  if (!first || Date.now() < followUntil || document.hidden) return;
  // only scroll when the highlighted paragraph is leaving the comfortable middle zone
  const r = first.getBoundingClientRect(), tr = t.getBoundingClientRect();
  if (r.top < tr.top + tr.height * 0.12 || r.top > tr.top + tr.height * 0.6) {
    t.scrollTo({ top: t.scrollTop + (r.top - tr.top) - tr.height * 0.3, behavior: 'smooth' });
  }
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

// While you touch or scroll, ask the voice engine to pause for a moment so the
// GPU is free to draw the screen (only when there is enough audio ahead).
let lastHold = 0;
function holdForUi() {
  const now = Date.now();
  if (now - lastHold < 400 || !ttsReady || ttsDevice !== 'webgpu') return;
  if (playing && secsAhead() < 25) return;
  lastHold = now;
  worker.postMessage({ type: 'hold', ms: 1500 });
}
for (const ev of ['pointerdown', 'touchstart', 'wheel']) document.addEventListener(ev, holdForUi, { passive: true, capture: true });
document.addEventListener('scroll', holdForUi, { passive: true, capture: true });

function saveProgress() { if (book) store.set('pos:' + book.id, pos); }

async function openBook(id) {
  const b = await getBook(id);
  if (!b) return;
  pause();
  if (tape) tape.stop();
  dropQueued();
  pending.clear();
  resetMem();
  stored.clear();
  chunkCache.clear();
  prep = null;
  book = b;
  store.set('currentBook', id);
  try { for (const r of await audioMeta(id)) stored.set(r.k, r.dur); } catch (e) { console.warn(e); }
  const saved = store.get('pos:' + id, { ch: 0, i: 0 });
  pos = { ch: Math.min(saved.ch, b.chapters.length - 1), i: 0 };
  pos.i = Math.min(saved.i, chunksOf(pos.ch).length - 1);
  $('#book-title').textContent = b.title;
  document.body.classList.add('has-book');
  renderChapter();
  renderHighlight();
  updateMoreLink();
  closePanels();
  updateMediaSession();
  fill();
  updateInfo();
}

function renderChapterList(filter = '') {
  const ul = $('#chapter-list');
  ul.textContent = '';
  const f = filter.trim().toLowerCase();
  const frag = document.createDocumentFragment();
  book.chapters.forEach((c, i) => {
    if (f && !(`${i + 1} ${c.title}`.toLowerCase().includes(f))) return;
    const li = document.createElement('li');
    li.dataset.ch = i;
    const n = document.createElement('span'); n.className = 'n'; n.textContent = i + 1;
    const t = document.createElement('span'); t.className = 't'; t.textContent = c.title;
    li.append(n, t);
    if (i === pos.ch) li.classList.add('current');
    frag.appendChild(li);
  });
  ul.appendChild(frag);
}
$('#chapter-list').addEventListener('click', (e) => {
  const li = e.target.closest('li[data-ch]');
  if (li) { goChapter(Number(li.dataset.ch)); closePanels(); }
});

async function renderLibrary() {
  const books = await listBooks();
  const ul = $('#library-list');
  ul.innerHTML = books.length ? '' : '<li class="empty">No books yet. Import an EPUB above, or grab chapters from a website.</li>';
  const trash = '<svg class="ic" aria-hidden="true"><use href="#i-trash"/></svg>';
  for (const b of books) {
    const li = document.createElement('li');
    li.innerHTML = `<div class="bt"></div><div class="ba"></div><button class="del icon" type="button" aria-label="Delete">${trash}</button>`;
    li.querySelector('.bt').textContent = b.title;
    li.querySelector('.ba').textContent = `${b.author ? b.author + ', ' : ''}${b.n} chapters`;
    li.onclick = (e) => { if (!e.target.closest('.del')) openBook(b.id); };
    li.querySelector('.del').onclick = async () => {
      if (!confirm(`Delete "${b.title}" (and its saved audio) from this device?`)) return;
      await deleteBook(b.id);
      if (book && book.id === b.id) { pause(); book = null; document.body.classList.remove('has-book'); store.set('currentBook', null); }
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
function closePanels() { document.querySelectorAll('.panel.open').forEach((p) => p.classList.remove('open')); }
function openPanel(id) { closePanels(); $(id).classList.add('open'); }
$('#btn-library').onclick = () => { renderLibrary(); openPanel('#library'); };
$('#btn-chapters').onclick = () => {
  if (!book) return;
  openPanel('#chapters');
  // build the (possibly long) list after the panel starts opening, so the tap feels instant
  requestAnimationFrame(() => { renderChapterList($('#chapter-filter').value); const c = $('#chapter-list .current'); if (c) c.scrollIntoView({ block: 'center' }); });
};
$('#btn-settings').onclick = () => openPanel('#settings');
$('#btn-offline').onclick = () => { if (!book) return; updateInfo(); openPanel('#offline'); };
document.querySelectorAll('.panel .close').forEach((b) => (b.onclick = closePanels));
let filterT = 0;
$('#chapter-filter').addEventListener('input', (e) => { clearTimeout(filterT); filterT = setTimeout(() => renderChapterList(e.target.value), 150); });
$('#chapter-go').addEventListener('submit', (e) => {
  e.preventDefault();
  const n = parseInt($('#chapter-filter').value, 10);
  if (n >= 1 && n <= book.chapters.length) { goChapter(n - 1); closePanels(); }
});
document.querySelectorAll('[data-prep]').forEach((b) => (b.onclick = () => { startPrepare(Number(b.dataset.prep)); }));
$('#off-stop').onclick = stopPrepare;
$('#off-clear').onclick = async () => {
  if (!book || !confirm('Delete all saved audio for this book?')) return;
  stopPrepare();
  await deleteAudioWhere(book.id, () => true);
  stored.clear();
  updateInfo();
  showStorage();
};
async function showStorage() {
  try {
    const e = await navigator.storage.estimate();
    $('#off-storage').textContent = `Using ${(e.usage / 1e6).toFixed(0)} MB on this phone (includes the ~330 MB voice model).`;
  } catch {}
}
$('#btn-offline').addEventListener('click', showStorage);

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
  // The passage that's playing now finishes in the old voice; the next one uses the new voice.
  settings.voice = voiceSel.value; store.set('voice', settings.voice);
  dropQueued();
  if (tape) tape.cutAfter(pos);
  fill();
  updateInfo();
  setStatus('The new voice starts after this passage.');
};
$('#preview').onclick = () => {
  if (!ttsReady) return setStatus('Voice engine still loading…');
  const id = ++reqId; pending.set(id, { preview: true });
  worker.postMessage({ type: 'gen', id, preview: true, voice: settings.voice, pad: 0, text: 'The ancient sword hummed in his hand. "So this is the power of the heavens," he whispered, as the sky split open above him.' });
};
const rateSel = $('#rate');
const rateLbl = $('#rate-val');
const showRate = () => { rateLbl.textContent = settings.rate.toFixed(2) + '×'; $('#speed-btn').textContent = settings.rate.toFixed(2).replace(/0$/, '') + '×'; };
rateSel.value = settings.rate; showRate();
rateSel.oninput = () => { settings.rate = Number(rateSel.value); store.set('rate', settings.rate); el.playbackRate = settings.rate; el.defaultPlaybackRate = settings.rate; showRate(); updateInfo(); };
$('#speed-btn').onclick = () => {
  const steps = [1, 1.15, 1.25, 1.4, 1.5, 1.75, 2];
  const i = steps.findIndex((s) => s > settings.rate + 0.01);
  settings.rate = i === -1 ? steps[0] : steps[i];
  rateSel.value = settings.rate; rateSel.oninput();
};
const devSel = $('#device');
devSel.value = settings.device;
devSel.onchange = () => { store.set('device', devSel.value); location.reload(); };
const gpuSel = $('#gpu');
gpuSel.value = settings.gpu;
gpuSel.onchange = () => { settings.gpu = gpuSel.value; store.set('gpu', settings.gpu); lastPace = -1; setPace(); };
const aheadSel = $('#ahead');
aheadSel.value = String(settings.aheadMin);
aheadSel.onchange = () => { settings.aheadMin = Number(aheadSel.value); store.set('aheadMin', settings.aheadMin); fill(); updateInfo(); };
function showAwayLog() {
  const r = store.get('lastAway', null);
  const box = $('#away-log');
  if (!r) { box.textContent = 'Nothing yet. After you come back from listening with the screen off, a short report appears here.'; return; }
  box.textContent = [new Date(r.at).toLocaleString(), r.msg, ...(r.events || [])].join('\n');
}
showAwayLog();
const modeSel = $('#mode');
modeSel.value = store.get('mode', 'auto');
modeSel.onchange = () => {
  store.set('mode', modeSel.value);
  if (modeSel.value === 'auto') delete document.documentElement.dataset.mode;
  else document.documentElement.dataset.mode = modeSel.value;
};

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

// ---------- only one Reader runs the voice engine at a time ----------
// Every "Open in Reader" opens a new tab; without this, each open tab would run
// its own copy of the voice engine on the GPU. The newest Reader wins and older
// ones pause and shut their engine down.
const instanceId = Math.random().toString(36).slice(2);
let retired = false;
try {
  const bc = new BroadcastChannel('novel-reader');
  bc.onmessage = (e) => { if (e.data && e.data.type === 'hello' && e.data.id !== instanceId && !retired) retire(); };
  bc.postMessage({ type: 'hello', id: instanceId });
} catch {}
function retire() {
  retired = true;
  pause();
  if (tape) tape.stop();
  prep = null;
  try { wakeLock?.release(); } catch {}
  worker.terminate();
  ttsReady = false;
  el.removeAttribute('src'); el.load();
  closePanels();
  const note = document.createElement('div');
  note.className = 'retired-note';
  note.setAttribute('role', 'alert');
  const t = document.createElement('p');
  t.textContent = 'The Reader is open in another tab, so this one has paused and switched its voice engine off to save the GPU.';
  const btn = document.createElement('button');
  btn.type = 'button'; btn.className = 'btn primary'; btn.textContent = 'Use this tab instead';
  btn.onclick = () => location.reload();
  note.append(t, btn);
  document.body.appendChild(note);
  setStatus('Paused: open in another tab');
}
// ---------- bookmarklet installer ----------
const APP_URL = location.origin + location.pathname.replace(/[^/]*$/, '');
async function buildBookmarklet() {
  const src = await (await fetch('grab.min.js', { cache: 'no-cache' })).text();
  const code = src.trim().replace('__APP_URL__', APP_URL);
  return 'javascript:' + code.replace(/[%#]/g, encodeURIComponent);
}
const shortBookmarklet = () => `javascript:(function(){var s=document.createElement('script');s.charset='utf-8';s.onerror=function(){alert('Site blocked the SHORT bookmarklet. Use the FULL one.')};s.src='${APP_URL}grab.js?'+Date.now();document.documentElement.appendChild(s)})()`;
$('#bm-card').addEventListener('toggle', async (e) => {
  if (e.target.open && !$('#bm-code').value) $('#bm-code').value = await buildBookmarklet();
  if (e.target.open) $('#bm-short').value = shortBookmarklet();
});
$('#copy-short').onclick = async () => {
  const code = shortBookmarklet();
  $('#bm-short').value = code;
  try { await navigator.clipboard.writeText(code); $('#copy-short-msg').textContent = ' Copied ✓'; }
  catch { $('#bm-short').select(); document.execCommand('copy'); $('#copy-short-msg').textContent = ' Copied'; }
};
$('#copy-bm').onclick = async () => {
  const code = $('#bm-code').value || (await buildBookmarklet());
  $('#bm-code').value = code;
  try { await navigator.clipboard.writeText(code); $('#copy-msg').textContent = ' Copied ✓'; }
  catch { $('#bm-code').select(); document.execCommand('copy'); $('#copy-msg').textContent = ' Copied (select-all fallback)'; }
};
function updateMoreLink() {
  const a = $('#more-chapters');
  const m = book && book.id.match(/^wn:(\d+)$/);
  const last = book && book.chapters[book.chapters.length - 1];
  if (m) a.href = `https://www.webnovel.com/book/${m[1]}/${last.id}`;
  else if (last && /^https?:/.test(String(last.id))) a.href = last.id;
  else { a.classList.add('hidden'); return; }
  a.textContent = 'Get more chapters: opens the last chapter, then run the bookmarklet';
  a.classList.remove('hidden');
}

// ---------- receive chapters from the bookmarklet ----------
function validPayload(d) {
  return d && d.type === 'wn-chapters' && d.book && typeof d.book.id === 'string' && Array.isArray(d.chapters) && d.chapters.length > 0 &&
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
  setStatus(`Added ${d.chapters.length} chapter${d.chapters.length > 1 ? 's' : ''}. Tap play to listen.`);
}
// Chapters can also arrive in the address itself (#import=<gzip+base64url JSON>),
// from the "Open in Reader" link — that path can't be stopped by pop-up blockers.
async function decodeHashPayload(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '==='.slice((b64.length + 3) % 4));
  const u8 = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  const stream = new Blob([u8]).stream().pipeThrough(new DecompressionStream('gzip'));
  return JSON.parse(await new Response(stream).text());
}

(async () => {
  const hm = location.hash.match(/^#import=(.+)$/);
  if (hm) {
    history.replaceState(null, '', location.pathname + location.search.replace(/[?&]import=1/, ''));
    try {
      const d = await decodeHashPayload(hm[1]);
      if (validPayload(d)) { await importChapters(d); return; }
      setStatus('Those chapters could not be read.');
    } catch (e) { console.error(e); setStatus('Those chapters could not be read: ' + e.message); }
  }
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
window.__app = { get pos() { return pos; }, get playing() { return playing; }, mem, stored, pending, chunksOf, get book() { return book; }, get prep() { return prep; }, akey, speakable };
