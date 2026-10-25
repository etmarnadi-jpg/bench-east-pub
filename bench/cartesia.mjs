// H1 (7 Oct 2026): what the bench (run.mjs) and the hearing probe (hear.mjs)
// ask Cartesia for, with a spend counter that stops before a limit is passed.
//
// - Text-to-speech: POST /tts/bytes (lib/testcall.mjs ttsBody: sonic-3.6, raw
//   16 kHz 16-bit PCM) plus generation_config.speed (docs: 0.6 to 1.5).
//   About 1 credit a character.
// - Speech-to-text: the realtime manual endpoint wss://api.cartesia.ai/stt/websocket
//   with model ink-2 ("built for production voice agents", docs.cartesia.ai
//   build-with-cartesia/stt/latest, read 7 Oct 2026; the agent docs say only
//   that "Ink" hears the caller, not which version). Binary PCM up, then
//   "finalize"; transcript chunks back ({type:"transcript", is_final, text});
//   "close" ends with {type:"done"}.
// - Accounts: only C or D, the key by lib/accounts.mjs accountKey, never shown.
// - A 402, or any answer that speaks of credit, payment, balance or quota,
//   throws a MoneyError: the caller stops at the first one.
import { accountKey, checkLetter, upper } from '../lib/accounts.mjs';
import { ttsBody, SAMPLE_RATE } from '../lib/testcall.mjs';

export const API = 'https://api.cartesia.ai';
export const VERSION = '2026-08-14';
export const STT_MODEL = 'ink-2';
export const STT_URL = 'wss://api.cartesia.ai/stt/websocket';
export const BYTES_PER_SECOND = SAMPLE_RATE * 2;

/**
 * The bench never uses account B (Luterson's live line). A, C and D are the testing accounts (Ethan, 9 Oct 2026:
 * Cartesia is the testing service; the free credit on A, C and D may be used up on tests). Using A stops the two
 * demo phone robots when its credit runs out.
 */
export function benchAccount(letter) {
  const l = checkLetter(letter, '--account');
  if (l === 'b') throw new Error(`account B is refused: it is Luterson's live line; the bench runs only on the testing accounts A, C or D`);
  return l;
}

export class MoneyError extends Error {}
const MONEY = /credit|payment|billing|balance|quota|insufficient|overage|subscription|402/i;

/** Throws a MoneyError for an answer that speaks of money, else a plain error. */
export function failure(what, status, body) {
  const text = String(body || '').slice(0, 300);
  if (status === 402 || MONEY.test(text)) return new MoneyError(`${what}: Cartesia said ${status}: ${text} (stopped at the first credit or payment error)`);
  return new Error(`${what}: Cartesia said ${status}: ${text}`);
}

/** Counts what a run spends and refuses to pass its limits. */
export class Spend {
  constructor({ maxChars = 6000, maxHeardSeconds = 600 } = {}) {
    this.maxChars = maxChars; this.maxHeardSeconds = maxHeardSeconds;
    this.chars = 0; this.heardSeconds = 0; this.spokenSeconds = 0; this.ttsCalls = 0; this.sttCalls = 0;
  }
  canSpeak(text) { return this.chars + String(text).length <= this.maxChars; }
  speak(text) {
    if (!this.canSpeak(text)) throw new Error(`speech limit: ${this.chars} + ${String(text).length} characters would pass ${this.maxChars}`);
    this.chars += String(text).length; this.ttsCalls++;
  }
  canHear(seconds) { return this.heardSeconds + seconds <= this.maxHeardSeconds; }
  hear(seconds) {
    if (!this.canHear(seconds)) throw new Error(`hearing limit: ${this.heardSeconds.toFixed(1)} + ${seconds.toFixed(1)} s would pass ${this.maxHeardSeconds} s`);
    this.heardSeconds += seconds; this.sttCalls++;
  }
  text() {
    return `${this.chars} characters spoken (${this.ttsCalls} TTS requests, ${this.spokenSeconds.toFixed(1)} s of audio made), ${this.heardSeconds.toFixed(1)} s of audio heard (${(this.heardSeconds / 60).toFixed(2)} minutes, ${this.sttCalls} STT sessions)`;
  }
}

/** The POST /tts/bytes body at a speed (1 = normal). */
export function ttsRequest(text, voice, speed = 1) {
  const body = ttsBody(text, voice);
  if (speed !== 1) {
    if (!(speed >= 0.6 && speed <= 1.5)) throw new Error(`TTS speed ${speed} is outside 0.6 to 1.5`);
    body.generation_config = { speed };
  }
  return body;
}

/**
 * H2 (7 Oct 2026): the speech without the silence TTS puts before and after it (a margin of marginMs kept).
 * The bench measures the gap from the end of the caller's audio, so trailing silence would hide part of
 * the real gap (the caller's last word came earlier) and leading silence only costs agent time.
 * Returns { pcm, leadMs, tailMs } (what was cut).
 */
export function trimSilence(pcm, { threshold = 500, marginMs = 30 } = {}) {
  const n = Math.floor(pcm.length / 2);
  const loud = (i) => Math.abs(pcm.readInt16LE(i * 2)) > threshold;
  let a = 0; while (a < n && !loud(a)) a++;
  if (a >= n) return { pcm, leadMs: 0, tailMs: 0 };
  let b = n - 1; while (b > a && !loud(b)) b--;
  const margin = Math.round((SAMPLE_RATE * marginMs) / 1000);
  const from = Math.max(0, a - margin);
  const to = Math.min(n, b + 1 + margin);
  return { pcm: pcm.subarray(from * 2, to * 2), leadMs: Math.round((from * 1000) / SAMPLE_RATE), tailMs: Math.round(((n - to) * 1000) / SAMPLE_RATE) };
}

export const silence = (ms) => Buffer.alloc(Math.round((BYTES_PER_SECOND * ms) / 1000 / 2) * 2);
export const seconds = (pcm) => pcm.length / BYTES_PER_SECOND;

/** One TTS request; the spend is counted before it is sent. */
export async function speak({ key, text, voice, speed = 1, spend, fetchImpl = fetch }) {
  if (process.env.BENCH_CALLER_TTS === 'deepgram') return speakDeepgram({ text, voice, spend, fetchImpl });
  spend.speak(text);
  let res;
  for (let tries = 0; ; tries++) {
    res = await fetchImpl(`${API}/tts/bytes`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Cartesia-Version': VERSION, 'Content-Type': 'application/json' },
      body: JSON.stringify(ttsRequest(text, voice, speed)),
      signal: AbortSignal.timeout(60_000),
    });
    if (res.ok) break;
    const body = await res.text().catch(() => '');
    // HW (8 Oct 2026): 429 "concurrency_limited" is the free plan's two-at-once limit (the receptionist's own
    // voice on the same account counts), not money: wait a moment and try again, four times at most.
    if (res.status === 429 && /concurrency/i.test(body) && tries < 4) { await new Promise((r) => setTimeout(r, 1200)); continue; }
    throw failure('text-to-speech', res.status, body);
  }
  const pcm = Buffer.from(await res.arrayBuffer());
  spend.spokenSeconds += seconds(pcm);
  return pcm;
}

// 10 Oct 2026: Cartesia C and D are out of free voice credit, so the fake caller can speak with a Deepgram voice
// (BENCH_CALLER_TTS=deepgram, key BENCH_DEEPGRAM_KEY in ~/ethan/secrets/deepgram/, default "2"; key "1" is the live line's).
// Aura-2 has no accents to match the personas: each Cartesia voice id maps to a fixed Aura-2 voice that is not the receptionist's.
const DG_CALLER_VOICES = ['apollo', 'hera', 'draco', 'theia', 'orion', 'luna', 'arcas', 'athena'];
async function speakDeepgram({ text, voice, spend, fetchImpl }) {
  spend.speak(text);
  const { readFileSync } = await import('node:fs');
  const { homedir } = await import('node:os');
  const key = readFileSync(`${homedir()}/ethan/secrets/deepgram/${process.env.BENCH_DEEPGRAM_KEY || '2'}`, 'utf8').trim();
  let h = 0;
  for (const ch of String(voice ?? '')) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const model = `aura-2-${DG_CALLER_VOICES[h % DG_CALLER_VOICES.length]}-en`;
  const res = await fetchImpl(`https://api.deepgram.com/v1/speak?model=${model}&encoding=linear16&sample_rate=${SAMPLE_RATE}&container=none`, {
    method: 'POST', headers: { Authorization: `Token ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }), signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw failure('text-to-speech (Deepgram)', res.status, await res.text().catch(() => ''));
  const pcm = Buffer.from(await res.arrayBuffer());
  spend.spokenSeconds += seconds(pcm);
  return pcm;
}

/** Parts said one after another with a pause between (the pace that stops mid-number). */
export async function speakParts({ parts, pauseMs = 1500, trim = false, ...rest }) {
  // sq1 (f2): the parts render at once (one after another cost the caller seconds); with trim, each part's own edge silence is
  // cut, so the stop between two parts is pauseMs itself
  const pcms = await Promise.all(parts.map((p) => speak({ ...rest, text: p })));
  const out = [];
  for (const [i, pcm] of pcms.entries()) {
    if (i) out.push(silence(Array.isArray(pauseMs) ? pauseMs[i - 1] : pauseMs));   // a stop each, or one for all
    out.push(trim ? trimSilence(pcm).pcm : pcm);
  }
  return Buffer.concat(out);
}

/** The STT WebSocket URL (no key in it: the key goes in the X-API-Key header). */
export function sttUrl({ keyterms = [] } = {}) {
  const q = new URLSearchParams({ model: STT_MODEL, encoding: 'pcm_s16le', sample_rate: String(SAMPLE_RATE), cartesia_version: VERSION, language: 'en' });
  for (const k of keyterms) q.append('keyterm', k);
  return `${STT_URL}?${q}`;
}

/** Hears one piece of audio: ~100 ms chunks, then finalize and close; the final text. */
export function hear({ key, pcm, spend, keyterms = [], openSocket = (url, headers) => new WebSocket(url, { headers }), timeoutMs = 30_000 }) {
  const secs = seconds(pcm) + 0.5;               // plus the half second of silence sent after it
  spend.hear(secs);
  return new Promise((resolve, reject) => {
    const ws = openSocket(sttUrl({ keyterms }), { 'X-API-Key': key });
    ws.binaryType = 'arraybuffer';
    let text = '';
    let done = false;
    const end = (err) => {
      if (done) return; done = true; clearTimeout(timer);
      try { ws.close(1000); } catch { /* closed */ }
      if (err) reject(err); else resolve(text.trim());
    };
    const timer = setTimeout(() => end(new Error('speech-to-text: no answer in time')), timeoutMs);
    ws.onopen = () => {
      const audio = Buffer.concat([pcm, silence(500)]);
      const size = BYTES_PER_SECOND / 10;
      for (let i = 0; i < audio.length; i += size) ws.send(audio.subarray(i, Math.min(i + size, audio.length)));
      ws.send('finalize');
      ws.send('close');
    };
    ws.onmessage = (m) => {
      let e;
      try { e = JSON.parse(typeof m.data === 'string' ? m.data : Buffer.from(m.data).toString()); } catch { return; }
      if (e.type === 'transcript' && e.is_final) text += e.text || '';
      else if (e.type === 'done') end();
      else if (e.type === 'error') end(failure('speech-to-text', e.status_code || e.code || 'error', e.message || e.error || JSON.stringify(e)));
    };
    ws.onerror = (err) => end(failure('speech-to-text', 'socket', err?.message || err?.type || 'socket error'));
    ws.onclose = (c) => (c?.code && c.code !== 1000 && !done ? end(failure('speech-to-text', `closed ${c.code}`, c.reason || '')) : end());
  });
}

/** The account key, never shown (only C or D). */
export const benchKey = (letter, home) => accountKey(benchAccount(letter), home);
