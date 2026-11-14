// Runs Kokoro TTS off the main thread. Requests are processed one at a time.
let tts = null;
let mock = false;
const queue = [];
let busy = false;

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
      // warm-up so the first real sentence is fast
      await tts.generate('Ready.', { voice: 'af_heart' });
      postMessage({ type: 'ready', device: 'webgpu' });
      return;
    } catch (e) {
      postMessage({ type: 'log', msg: 'WebGPU failed, falling back to CPU: ' + e });
    }
  }
  tts = await KokoroTTS.from_pretrained(model, { dtype: 'q8', device: 'wasm', progress_callback });
  postMessage({ type: 'ready', device: 'wasm' });
}

async function pump() {
  if (busy) return;
  busy = true;
  while (queue.length) {
    const job = queue.shift();
    const t0 = performance.now();
    try {
      let wav;
      if (mock) {
        const rate = 24000;
        const secs = Math.max(0.3, job.text.length / 400);
        const s = new Float32Array(Math.round(rate * secs));
        for (let i = 0; i < s.length; i++) s[i] = 0.05 * Math.sin(i / 20);
        await new Promise((r) => setTimeout(r, 30));
        wav = toWav(s, rate);
      } else {
        const out = await tts.generate(job.text, { voice: job.voice, speed: 1 });
        wav = toWav(out.audio, out.sampling_rate);
      }
      postMessage({ type: 'audio', id: job.id, wav, ms: performance.now() - t0 }, [wav]);
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
    queue.length = 0;
  }
};
