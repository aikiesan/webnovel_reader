// One continuous audio stream for the whole listening session.
//
// Playing each passage as its own file leaves a tiny gap between files; Chrome
// on Android treats that gap in a background tab as "playback stopped" and
// freezes the page. Instead, a single <audio> element is fed through
// MediaSource: saved Opus passages are re-wrapped (no re-encoding) as WebM
// pieces and appended to the end of the stream while it plays, so from the
// browser's point of view it is one long track that never ends.

export const tapeSupported = () =>
  typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported('audio/webm; codecs="opus"');

// ---------- Ogg -> Opus packets ----------
export function oggPackets(buf) {
  const u8 = new Uint8Array(buf);
  const packets = [];
  let cur = [];
  let o = 0;
  while (o + 27 <= u8.length) {
    if (u8[o] !== 0x4f || u8[o + 1] !== 0x67 || u8[o + 2] !== 0x67 || u8[o + 3] !== 0x53) throw new Error('not an Ogg file');
    const nseg = u8[o + 26];
    let d = o + 27 + nseg;
    for (let i = 0; i < nseg; i++) {
      const len = u8[o + 27 + i];
      cur.push(u8.subarray(d, d + len));
      d += len;
      if (len < 255) {
        const size = cur.reduce((a, c) => a + c.length, 0);
        const p = new Uint8Array(size); let q = 0;
        for (const c of cur) { p.set(c, q); q += c.length; }
        packets.push(p); cur = [];
      }
    }
    o = d;
  }
  return { head: packets[0], audio: packets.slice(2) }; // [OpusHead, OpusTags, ...audio]
}

// ---------- minimal WebM (EBML) writer ----------
const concat = (parts) => {
  const n = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(n); let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
const vint = (n) => {
  for (let len = 1; len <= 8; len++) {
    if (n < 2 ** (7 * len) - 1) {
      const b = new Uint8Array(len);
      let v = n;
      for (let i = len - 1; i >= 0; i--) { b[i] = v & 0xff; v = Math.floor(v / 256); }
      b[0] |= 1 << (8 - len);
      return b;
    }
  }
  throw new Error('size too large');
};
const uint = (n) => { const b = []; do { b.unshift(n & 0xff); n = Math.floor(n / 256); } while (n > 0); return new Uint8Array(b); };
const str = (s) => new TextEncoder().encode(s);
const f64 = (x) => { const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, x); return b; };
const id = (hex) => new Uint8Array(hex.match(/../g).map((h) => parseInt(h, 16)));
const el = (hex, ...children) => { const body = concat(children); return concat([id(hex), vint(body.length), body]); };
const UNKNOWN_SIZE = new Uint8Array([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);

export function webmInit(opusHead) {
  const ebml = el('1A45DFA3',
    el('4286', uint(1)), el('42F7', uint(1)), el('42F2', uint(4)), el('42F3', uint(8)),
    el('4282', str('webm')), el('4287', uint(4)), el('4285', uint(2)));
  const info = el('1549A966', el('2AD7B1', uint(1000000)), el('4D80', str('novel-reader')), el('5741', str('novel-reader')));
  const tracks = el('1654AE6B', el('AE',
    el('D7', uint(1)), el('73C5', uint(1)), el('83', uint(2)), el('86', str('A_OPUS')),
    el('63A2', opusHead),
    el('E1', el('B5', f64(48000)), el('9F', uint(1)))));
  return concat([ebml, id('18538067'), UNKNOWN_SIZE, info, tracks]);
}

// Opus frames are 20 ms each (the worker encodes with frameDuration 20000).
const FRAME_MS = 20;
export function webmClusters(packets) {
  const parts = [];
  for (let start = 0; start < packets.length; start += 1500) { // a cluster per 30 s keeps block offsets in int16
    const blocks = [];
    const n = Math.min(1500, packets.length - start);
    for (let i = 0; i < n; i++) {
      const hdr = new Uint8Array(4);
      hdr[0] = 0x81; // track 1
      new DataView(hdr.buffer).setInt16(1, i * FRAME_MS);
      hdr[3] = 0x80; // keyframe
      blocks.push(el('A3', hdr, packets[start + i]));
    }
    parts.push(el('1F43B675', el('E7', uint(start * FRAME_MS)), ...blocks));
  }
  return concat(parts);
}

// ---------- the tape ----------
// getAudio(pos) -> Promise<Blob | 'skip' | null>   (null = not ready yet)
// next(pos) -> pos | null
export class Tape {
  constructor(audioEl, { getAudio, next, onPos, onEnd, onError }) {
    Object.assign(this, { audioEl, getAudio, next, onPos, onEnd, onError });
    this.token = 0;
    this.entries = [];
    this.active = false;
    this.aheadSecs = 240; // how much is appended to the stream in advance (raised while the screen is off)
    this.full = false;    // the browser's buffer quota was reached
    audioEl.addEventListener('timeupdate', () => this.tick());
    // top up on a timer too, in case timeupdate events are throttled in the background
    setInterval(() => this.pump(), 2000);
  }

  // Start a fresh stream at `pos`. Returns once the stream can accept data.
  start(pos) {
    const token = ++this.token;
    this.active = true;
    this.entries = [];
    this.startPos = pos;
    this.lastPos = null;
    this.done = false;
    this.headSent = false;
    this.sb = null;
    this.pumping = false;
    this.ms = new MediaSource();
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = URL.createObjectURL(this.ms);
    this.audioEl.src = this.url;
    return new Promise((res) => {
      this.ms.addEventListener('sourceopen', () => {
        if (token !== this.token) return res();
        this.sb = this.ms.addSourceBuffer('audio/webm; codecs="opus"');
        this.sb.mode = 'sequence';
        res();
        this.pump();
      }, { once: true });
    });
  }

  stop() {
    this.token++;
    this.active = false;
    this.entries = [];
  }

  appendBytes(bytes) {
    return new Promise((res, rej) => {
      const sb = this.sb;
      const ok = () => { sb.removeEventListener('error', bad); res(); };
      const bad = () => { sb.removeEventListener('updateend', ok); rej(new Error('append failed')); };
      sb.addEventListener('updateend', ok, { once: true });
      sb.addEventListener('error', bad, { once: true });
      try { sb.appendBuffer(bytes); } catch (e) {
        sb.removeEventListener('updateend', ok); sb.removeEventListener('error', bad);
        if (e.name === 'QuotaExceededError') res(false); else rej(e);
      }
    });
  }

  bufferedEnd() {
    const b = this.sb && this.sb.buffered;
    return b && b.length ? b.end(b.length - 1) : 0;
  }

  // Append saved passages until enough is queued, then trim what was played.
  async pump() {
    if (!this.active || !this.sb || this.pumping || this.done) return;
    this.pumping = true;
    const token = this.token;
    try {
      while (token === this.token && !this.full && this.bufferedEnd() - this.audioEl.currentTime < this.aheadSecs) {
        const pos = this.lastPos ? this.next(this.lastPos) : this.startPos;
        if (!pos) {
          this.done = true;
          if (this.ms.readyState === 'open' && !this.sb.updating) this.ms.endOfStream();
          break;
        }
        const blob = await this.getAudio(pos);
        if (token !== this.token) return;
        if (!blob) break;                        // not generated yet: called again when it is
        if (blob === 'skip') { this.lastPos = pos; continue; }
        const { head, audio } = oggPackets(await blob.arrayBuffer());
        if (token !== this.token) return;
        if (!this.headSent) { await this.appendBytes(webmInit(head)); this.headSent = true; }
        const start = this.bufferedEnd();
        if ((await this.appendBytes(webmClusters(audio))) === false) { this.full = true; break; } // buffer full: retry after trimming
        if (token !== this.token) return;
        this.entries.push({ pos, start, end: this.bufferedEnd() });
        this.lastPos = pos;
      }
      // keep memory small: drop audio more than a minute behind the listener
      const t = this.audioEl.currentTime;
      if (token === this.token && t > 120 && this.sb.buffered.length && this.sb.buffered.start(0) < t - 90) {
        await new Promise((res) => { this.sb.addEventListener('updateend', res, { once: true }); this.sb.remove(0, t - 60); });
        this.entries = this.entries.filter((e) => e.end > t - 60);
        this.full = false;
      } else if (this.full && t - (this.sb.buffered.length ? this.sb.buffered.start(0) : t) > 30) {
        await new Promise((res) => { this.sb.addEventListener('updateend', res, { once: true }); this.sb.remove(0, t - 20); });
        this.entries = this.entries.filter((e) => e.end > t - 20);
        this.full = false;
      }
    } catch (e) {
      if (token === this.token && this.onError) this.onError(e);
    } finally {
      if (token === this.token) this.pumping = false;
    }
  }

  // Drop everything queued after `pos` (e.g. the voice changed) and refill from there.
  async cutAfter(pos) {
    if (!this.active || !this.sb) return;
    const i = this.entries.findIndex((e) => e.pos.ch === pos.ch && e.pos.i === pos.i);
    if (i < 0) return;
    const token = ++this.token;
    while (this.sb.updating) await new Promise((r) => this.sb.addEventListener('updateend', r, { once: true }));
    if (token !== this.token) return;
    const cutAt = this.entries[i].end;
    this.entries = this.entries.slice(0, i + 1);
    this.lastPos = pos;
    this.done = false;
    this.pumping = false;
    if (this.bufferedEnd() > cutAt + 0.01) {
      await new Promise((r) => { this.sb.addEventListener('updateend', r, { once: true }); this.sb.remove(cutAt, Infinity); });
    }
    if (token !== this.token) return;
    this.sb.timestampOffset = cutAt;
    this.pump();
  }

  // Which passage is playing right now?
  posAt(t) {
    for (const e of this.entries) if (t >= e.start - 0.05 && t < e.end) return e.pos;
    return null;
  }

  tick() {
    if (!this.active) return;
    const t = this.audioEl.currentTime;
    const p = this.posAt(t);
    if (p) this.onPos(p);
    if (this.done && this.entries.length && t >= this.entries[this.entries.length - 1].end - 0.15) this.onEnd();
    this.pump();
  }
}
