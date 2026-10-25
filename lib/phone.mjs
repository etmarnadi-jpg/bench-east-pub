// sm7 (14 Oct 2026, Elijah's real call to the live line: the greeting cut by his "hello", hums from the line's noise, "k" heard as
// "h a"): the bench caller sounds like a phone call when BENCH_PHONE=1. Its words go through a phone line (300-3400 Hz, 8 kHz,
// mu-law), every frame it sends carries line noise with an odd louder burst (a breath, the handset moving), it says "Hello?" as
// the line picks up, and a longer line stops once in the middle, as people do ("...to Redmond, [stop] a house I just bought.").
export const PHONE = process.env.BENCH_PHONE === '1';

function rng(seed) {   // mulberry32: the same noise each run
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

function biquad(x, type, f0, fs, q = 0.7071) {
  const w = 2 * Math.PI * f0 / fs, c = Math.cos(w), al = Math.sin(w) / (2 * q);
  let b0, b1, b2;
  if (type === 'lp') { b0 = (1 - c) / 2; b1 = 1 - c; b2 = (1 - c) / 2; } else { b0 = (1 + c) / 2; b1 = -(1 + c); b2 = (1 + c) / 2; }
  const a0 = 1 + al, a1 = -2 * c, a2 = 1 - al;
  const y = new Float64Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = (b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
  }
  return y;
}

const MU = 255;
const mulaw = (v) => { const s = Math.max(-1, Math.min(1, v / 32768)); const e = Math.sign(s) * Math.log1p(MU * Math.abs(s)) / Math.log1p(MU); const q = Math.round(e * 127) / 127; return Math.sign(q) * (Math.pow(1 + MU, Math.abs(q)) - 1) / MU * 32768; };

/** 16 kHz int16 PCM (a Buffer) as it comes out of a phone line. */
export function phoneBand(pcm) {
  const n = Math.floor(pcm.length / 2);
  let x = new Float64Array(n);
  for (let i = 0; i < n; i++) x[i] = pcm.readInt16LE(i * 2);
  x = biquad(biquad(x, 'hp', 300, 16000), 'hp', 300, 16000);
  x = biquad(biquad(biquad(x, 'lp', 3400, 16000), 'lp', 3400, 16000), 'lp', 3400, 16000);
  const out = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i += 2) {   // 8 kHz samples, mu-law, back to 16 kHz by halfway steps
    const a = mulaw(x[i]), b = i + 2 < n ? mulaw(x[i + 2]) : a;
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(a))), i * 2);
    if (i + 1 < n) out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round((a + b) / 2))), (i + 1) * 2);
  }
  return out;
}

/** Line noise for one frame (Int16Array, changed in place): a low hiss, and every 2-6 s a short louder burst. */
export function makeLineNoise(seed = 7) {
  const r = rng(seed);
  let untilBurst = 3000, burstLeft = 0, burstPeak = 0, prev = 0;
  return (int16, ms) => {
    untilBurst -= ms;
    if (untilBurst <= 0 && burstLeft <= 0) { burstLeft = 40 + r() * 80; burstPeak = 700 + r() * 1800; untilBurst = 2000 + r() * 4000; }
    const burst = burstLeft > 0; burstLeft -= ms;
    for (let i = 0; i < int16.length; i++) {
      const white = (r() * 2 - 1);
      prev = prev * 0.6 + white * 0.4;   // a softer, darker hiss than white noise
      let v = int16[i] + prev * 90 + (burst ? (r() * 2 - 1) * burstPeak : 0);
      int16[i] = Math.max(-32768, Math.min(32767, Math.round(v)));
    }
    return int16;
  };
}

/** Where a longer plain line stops once mid-way (people stop mid-line): [first part, rest], or null. */
export function midSplit(text, r = Math.random) {
  if (/\d/.test(text) || /(?:\b[A-Za-z]\b[\s,.-]*){3,}/.test(text)) return null;   // numbers and spellings have their own pace
  const words = text.trim().split(/\s+/);
  if (words.length < 9) return null;
  let at = -1;
  for (let i = 3; i < words.length - 3; i++) if (/,$/.test(words[i - 1])) { at = i; break; }
  if (at < 0) at = Math.floor(words.length * (0.45 + r() * 0.2));
  return [words.slice(0, at).join(' '), words.slice(at).join(' ')];
}

/** sm7l (plan step 7): the line said in one breath, with the stop put into the sound at its quietest 20 ms 40-65% of the way in.
 * Two parts said apart (speakParts) each end with the voice dropping, as if the caller had finished; a real caller's voice stays
 * up through a mid-line stop. 16-bit mono PCM in a Buffer at `sampleRate`. */
export function insertPause(pcm, pauseMs, sampleRate) {
  const n = pcm.length >> 1;
  const w = Math.round(sampleRate * 0.02);
  const lo = Math.floor(n * 0.4), hi = Math.floor(n * 0.65);
  let best = -1, bestE = Infinity;
  for (let i = lo; i + w <= hi; i += w >> 1) {
    let e = 0;
    for (let k = i; k < i + w; k++) { const v = pcm.readInt16LE(k * 2); e += v * v; }
    if (e < bestE) { bestE = e; best = i + (w >> 1); }
  }
  if (best < 0) return pcm;
  return Buffer.concat([pcm.subarray(0, best * 2), Buffer.alloc(Math.round((sampleRate * pauseMs) / 1000) * 2), pcm.subarray(best * 2)]);
}
