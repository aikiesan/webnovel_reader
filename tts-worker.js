// Runs Kokoro TTS off the main thread. Requests are processed one at a time.
// Each passage is returned as compressed Ogg/Opus (~24 kbps, ≈11 MB per hour)
// so the app can store hours of audio on the phone for background playback.
let tts = null;
let mock = false;
const queue = [];
let busy = false;
let holdUntil = 0; // main thread asks us to pause briefly while the user is touching the UI
let pace = 0;      // rest for (work time × pace) after each passage, so the GPU isn't busy all the time
let restUntil = 0;

// ---------- WAV (fallback when WebCodecs Opus is unavailable) ----------
function toWav(samples, rate) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); w(8, 'WAVE');
  w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buf;
}

// ---------- Ogg/Opus muxer ----------
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) { let r = i << 24; for (let k = 0; k < 8; k++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1; t[i] = r >>> 0; }
  return t;
})();
function oggPage(packets, granule, serial, seq, flags) {
  const lacing = [];
  for (const p of packets) { let n = p.length; while (n >= 255) { lacing.push(255); n -= 255; } lacing.push(n); }
  const body = packets.reduce((a, p) => a + p.length, 0);
  const page = new Uint8Array(27 + lacing.length + body);
  const v = new DataView(page.buffer);
  page.set([0x4f, 0x67, 0x67, 0x53]); // "OggS"
  page[5] = flags;
  v.setUint32(6, granule % 0x100000000, true); v.setUint32(10, Math.floor(granule / 0x100000000), true);
  v.setUint32(14, serial, true); v.setUint32(18, seq, true);
  page[26] = lacing.length; page.set(lacing, 27);
  let o = 27 + lacing.length;
  for (const p of packets) { page.set(p, o); o += p.length; }
  let c = 0;
  for (let i = 0; i < page.length; i++) c = ((c << 8) ^ CRC[((c >>> 24) ^ page[i]) & 0xff]) >>> 0;
  v.setUint32(22, c, true);
  return page;
}
const PRESKIP = 312;
function muxOggOpus(packets, rate) {
  const serial = (Math.random() * 0xffffffff) >>> 0;
  const head = new Uint8Array(19); const hv = new DataView(head.buffer);
  head.set([...'OpusHead'].map((c) => c.charCodeAt(0))); head[8] = 1; head[9] = 1;
  hv.setUint16(10, PRESKIP, true); hv.setUint32(12, rate, true);
  const vendor = 'novel-reader';
  const tags = new Uint8Array(8 + 4 + vendor.length + 4); const tv = new DataView(tags.buffer);
  tags.set([...'OpusTags'].map((c) => c.charCodeAt(0))); tv.setUint32(8, vendor.length, true);
  tags.set([...vendor].map((c) => c.charCodeAt(0)), 12);
  const pages = [oggPage([head], 0, serial, 0, 2), oggPage([tags], 0, serial, 1, 0)];
  let seq = 2, granule = PRESKIP, cur = [], segs = 0;
  for (let i = 0; i < packets.length; i++) {
    const p = packets[i];
    const need = Math.floor(p.data.length / 255) + 1;
    if (segs + need > 255 || cur.length >= 50) { pages.push(oggPage(cur, granule, serial, seq++, 0)); cur = []; segs = 0; }
    cur.push(p.data); segs += need; granule += p.samples48;
  }
  pages.push(oggPage(cur, granule, serial, seq, 4));
  return new Blob(pages, { type: 'audio/ogg; codecs=opus' });
}
let opusOk = null;
async function canOpus(rate) {
  if (opusOk === null) {
    try { opusOk = typeof AudioEncoder !== 'undefined' && (await AudioEncoder.isConfigSupported({ codec: 'opus', sampleRate: rate, numberOfChannels: 1, bitrate: 24000 })).supported; }
    catch { opusOk = false; }
  }
  return opusOk;
}
async function encodeOpus(samples, rate) {
  const packets = [];
  let err = null;
  const enc = new AudioEncoder({
    output: (chunk) => { const d = new Uint8Array(chunk.byteLength); chunk.copyTo(d); packets.push({ data: d, samples48: Math.round((chunk.duration || 20000) * 48 / 1000) }); },
    error: (e) => { err = e; },
  });
  enc.configure({ codec: 'opus', sampleRate: rate, numberOfChannels: 1, bitrate: 24000, opus: { application: 'voip', frameDuration: 20000 } });
  // pad the end so the encoder's look-ahead doesn't clip the last syllable
  const padded = new Float32Array(samples.length + Math.round(rate * 0.04));
  padded.set(samples);
  enc.encode(new AudioData({ format: 'f32', sampleRate: rate, numberOfFrames: padded.length, numberOfChannels: 1, timestamp: 0, data: padded }));
  await enc.flush();
  enc.close();
  if (err || !packets.length) throw err || new Error('no opus output');
  return muxOggOpus(packets, rate);
}

async function encode(samples, rate) {
  if (await canOpus(rate)) {
    try { return await encodeOpus(samples, rate); } catch (e) { opusOk = false; postMessage({ type: 'log', msg: 'Opus encode failed, using WAV: ' + e }); }
  }
  return new Blob([toWav(samples, rate)], { type: 'audio/wav' });
}

// ---------- model ----------
async function load({ device, isMock }) {
  if (isMock) {
    mock = true;
    postMessage({ type: 'ready', device: 'mock' });
    return;
  }
  const { KokoroTTS } = await import('./vendor/kokoro.web.js');
  const progress_callback = (p) => {
    if (p.status === 'progress' && p.file && /onnx/.test(p.file)) {
      postMessage({ type: 'progress', loaded: p.loaded, total: p.total });
    }
  };
  const model = 'onnx-community/Kokoro-82M-v1.0-ONNX';
  let useGpu = device !== 'wasm' && !!self.navigator.gpu;
  if (useGpu) {
    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) useGpu = false;
    } catch { useGpu = false; }
  }
  if (useGpu) {
    try {
      tts = await KokoroTTS.from_pretrained(model, { dtype: 'fp32', device: 'webgpu', progress_callback });
      await tts.generate('Ready.', { voice: 'af_heart' }); // warm-up so the first real sentence is fast
      postMessage({ type: 'ready', device: 'webgpu' });
      return;
    } catch (e) {
      postMessage({ type: 'log', msg: 'WebGPU failed, falling back to CPU: ' + e });
    }
  }
  tts = await KokoroTTS.from_pretrained(model, { dtype: 'q8', device: 'wasm', progress_callback });
  postMessage({ type: 'ready', device: 'wasm' });
}

// Trim Kokoro's own leading/trailing near-silence, then add our own pause so
// the gaps between passages are consistent (short after a sentence, longer
// after a paragraph).
function shape(samples, rate, padMs) {
  const th = 0.004;
  let a = 0, b = samples.length - 1;
  while (a < b && Math.abs(samples[a]) < th) a++;
  while (b > a && Math.abs(samples[b]) < th) b--;
  a = Math.max(0, a - Math.round(rate * 0.03));
  b = Math.min(samples.length - 1, b + Math.round(rate * 0.06));
  const pad = Math.round(rate * (padMs || 0) / 1000);
  const out = new Float32Array(b - a + 1 + pad);
  out.set(samples.subarray(a, b + 1));
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function pump() {
  if (busy) return;
  busy = true;
  while (queue.length) {
    // rests are re-checked every 100 ms, so they end at once if the app says audio is urgent
    while (Date.now() < Math.max(holdUntil, pace > 0 ? restUntil : 0)) await sleep(100);
    const job = queue.shift();
    if (!job) break;
    const t0 = performance.now();
    try {
      // A passage may hold several segments (narration, dialogue, system text),
      // each in its own voice and pace. Generate each, trim it, and join them
      // with a short gap; then add the passage's own pause at the end.
      const segs = job.segs || [{ text: job.text, voice: job.voice, speed: 1 }];
      const parts = [];
      let rate = 24000;
      for (const sg of segs) {
        let samples;
        if (mock) {
          samples = new Float32Array(Math.round(rate * Math.max(0.3, sg.text.length / 60 / (sg.speed || 1))));
          for (let i = 0; i < samples.length; i++) samples[i] = 0.05 * Math.sin(i / 20);
          await sleep(15);
        } else {
          const out = await tts.generate(sg.text, { voice: sg.voice, speed: sg.speed || 1 });
          samples = out.audio; rate = out.sampling_rate;
        }
        parts.push(shape(samples, rate, 0));
      }
      const gap = Math.round(rate * (job.gap || 0) / 1000);
      const pad = Math.round(rate * (job.pad || 0) / 1000);
      let samples = new Float32Array(parts.reduce((a, x) => a + x.length, 0) + gap * (parts.length - 1) + pad);
      let o = 0;
      parts.forEach((x, i) => { samples.set(x, o); o += x.length + (i < parts.length - 1 ? gap : 0); });
      const blob = await encode(samples, rate);
      const ms = performance.now() - t0;
      restUntil = Date.now() + ms * pace;
      postMessage({ type: 'audio', id: job.id, blob, dur: samples.length / rate, ms });
    } catch (e) {
      postMessage({ type: 'error', id: job.id, msg: String(e) });
    }
  }
  busy = false;
}

onmessage = async (e) => {
  const m = e.data;
  if (m.type === 'load') {
    try { await load(m); } catch (err) { postMessage({ type: 'fatal', msg: String(err) }); }
  } else if (m.type === 'gen') {
    queue.push(m);
    pump();
  } else if (m.type === 'clear') {
    const keep = queue.filter((j) => j.preview);
    const ids = queue.filter((j) => !j.preview).map((j) => j.id);
    queue.length = 0; queue.push(...keep);
    postMessage({ type: 'dropped', ids });
  } else if (m.type === 'pace') {
    pace = m.factor;
    if (!pace) restUntil = 0;
  } else if (m.type === 'hold') {
    holdUntil = Math.max(holdUntil, Date.now() + m.ms);
  }
};
