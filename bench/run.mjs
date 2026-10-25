// H1 (7 Oct 2026): the bench. A test call to a receptionist agent over
// Cartesia's agent WebSocket (lib/testcall.mjs runCall), with a caller who has
// a persona (bench/personas.mjs), an accent (a Cartesia voice, bench/voices.json)
// and a pace. The caller's words come from the Spark's local model
// (127.0.0.1:8082, gpt-oss-20b, the way luterson/check.mjs asks it) playing the
// persona and answering what the agent just said; Cartesia TTS speaks them on
// the bench's account and the audio goes up the call.
//
//   node bench/run.mjs --agent <agent_id> [--account c|d] [--line harbor]
//        [--persona diwakar,priya] [--accent indian,irish] [--pace slow,fast,pause]
//        [--max-minutes 3] [--run-minutes 15] [--max-chars 6000] [--live]
//
// DRY BY DEFAULT: without --live it prints every call it would make (persona,
// voice, pace, the persona's truth, the model's brief, the TTS body, the
// WebSocket) and sends nothing, reads no key. --dry says the same thing.
// --live is for the manager, with Ethan's yes for the agent minutes.
//
// Never on account A (the demo robots) or B (Luterson's line), never on
// Luterson's agent or the demo robots' agents: refused in code (refuseTarget),
// and live, the agent's own name is read first (GET /agents/{id}) and a
// Luterson agent is refused.
//
// Per call it saves out/bench/<time>-<persona>.json: every turn (the agent's
// words and tool calls; what Cartesia heard the caller say, beside what the
// caller really said), our gap (the end of the caller's audio to the first
// agent audio back), the agent's audio length per turn, the call id, the
// persona's truth, then Cartesia's own record (GET /agents/calls/{id}, for
// agent_turn_ms) and the human score (bench/human-score.mjs).
// A call stops at --max-minutes (default 3); the run at --run-minutes (default 15).
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readLine, workDaysOf } from '../lib/lineagent.mjs';
import { readKey } from '../lib/keys.mjs';
import { runCall, WS_BASE } from '../lib/testcall.mjs';
import { runRoomCall } from '../lib/livekitcall.mjs';
import { fetchCall } from '../tools/call-speed.mjs';
import { PHONE, phoneBand, midSplit, insertPause } from '../lib/phone.mjs';
import { SAMPLE_RATE } from '../lib/testcall.mjs';
import { benchAccount, benchKey, speak, speakParts, ttsRequest, trimSilence, Spend, MoneyError, API, VERSION } from './cartesia.mjs';
import { PERSONAS, personaTruth, callerPrompt } from './personas.mjs';
import { SITE } from '../lib/voice.mjs';
import { humanScore, scoreText, spokenDigits } from './human-score.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const VOICES = JSON.parse(readFileSync(join(HERE, 'voices.json'), 'utf8')).accents;
export const MODEL_URL = process.env.BENCH_MODEL_URL || 'http://127.0.0.1:8082/v1';
export const MODEL = 'gpt-oss-20b';
/** H3: the most TTS characters one run may ask for (--max-chars may only lower it). */
export const MAX_CHARS = 6000;

/** Agents the bench never calls, whatever account they are on (TRUTH.md; README.md). */
export const REFUSED_AGENTS = {
  agent_kDYCb1twzxgepgr4eVkaZv: "Luterson's line (account B)",
  agent_fpmvU6bVNf7RHKeXRcoJnn: 'the Summit Comfort demo robot (account A)',
  agent_atAk5STNzVsyCRF55LudJq: 'the Northstar Movers demo robot (account A)',
};

export const PACES = {
  slow: { speed: 0.75, why: 'TTS at 0.75x' },
  normal: { speed: 1, why: 'TTS at 1x' },
  fast: { speed: 1.35, why: 'TTS at 1.35x' },
  pause: { speed: 1, pauseMs: 1500, why: 'TTS at 1x, with a 1.5 s stop in the middle of a phone number' },
};
const PACE_ORDER = ['normal', 'slow', 'fast', 'pause'];

/** Throws a plain sentence for an account or agent the bench must never use. */
export function refuseTarget({ account, agent, lutersonAgentName = 'Luterson Moving line' }) {
  const letter = benchAccount(account);
  if (!agent) throw new Error('--agent <agent id> is needed (the test agent on account C or D)');
  if (!/^agent_[A-Za-z0-9]{6,60}$/.test(agent)) throw new Error(`not an agent id: ${agent}`);
  if (REFUSED_AGENTS[agent]) throw new Error(`agent ${agent} is refused: it is ${REFUSED_AGENTS[agent]}`);
  return { letter, agent, lutersonAgentName };
}

/**
 * H3 (Astra H-human 1): the bench calls only a TEST line (its line.json says `"test": true`, as the
 * site's LINES does), checked before any key is read: a run with --line luterson would load his
 * line key and ask his real calendar which dates are free. Throws a plain sentence.
 */
export function refuseLine(line) {
  if (line?.test !== true) throw new Error(`line "${line?.id}" is refused: the bench runs only on a test line (its line.json has "test": true), never a real customer's`);
  return line;
}

/**
 * Live only: the agent's own name, read before the call; a Luterson agent is refused.
 * H3: with `lineAgent`, the agent must be that line's own agent (its name is the line.json "agent"),
 * so the test agent of one line never reads another line's calendar.
 */
export async function checkAgentName({ key, agent, lutersonAgentName, lineAgent = '', lineId = '', fetchImpl = fetch }) {
  const res = await fetchImpl(`${API}/agents/${encodeURIComponent(agent)}`, { method: 'GET', headers: { Authorization: `Bearer ${key}`, 'Cartesia-Version': VERSION } });
  if (!res.ok) throw new Error(`GET /agents/${agent} answered ${res.status}: it is not on this account, so no call`);
  const a = await res.json();
  const name = String(a.name || '');
  if (name === lutersonAgentName || /luterson/i.test(name)) throw new Error(`agent ${agent} is "${name}": Luterson's agent is refused`);
  if (lineAgent && name !== lineAgent) throw new Error(`agent ${agent} is "${name}", not the ${lineId || 'chosen'} line's own agent "${lineAgent}": refused`);
  return name;
}

const list = (v) => String(v || '').split(',').map((x) => x.trim()).filter(Boolean);

export function parseArgs(argv) {
  const o = { agent: '', account: 'c', line: 'harbor', persona: [], accent: [], pace: [], maxMinutes: 3, runMinutes: 15, maxChars: 6000, live: false, today: '', keepHolds: false, livekit: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { if (i + 1 >= argv.length) throw new Error(`${a} needs a value`); return argv[++i]; };
    if (a === '--agent') o.agent = val();
    else if (a === '--account') o.account = val();
    else if (a === '--line') o.line = val();
    else if (a === '--persona') o.persona = list(val());
    else if (a === '--accent') o.accent = list(val());
    else if (a === '--pace') o.pace = list(val());
    else if (a === '--max-minutes') o.maxMinutes = Number(val());
    else if (a === '--run-minutes') o.runMinutes = Number(val());
    else if (a === '--max-chars') o.maxChars = Number(val());
    else if (a === '--today') o.today = val();
    else if (a === '--dry') o.live = false;
    else if (a === '--live') o.live = true;
    else if (a === '--keep-holds') o.keepHolds = true;
    // HW (8 Oct 2026): the LiveKit receptionist (livekit/agent.py) instead of a Cartesia agent; the caller's voice still comes from --account.
    else if (a === '--livekit') o.livekit = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  for (const p of o.persona) if (!PERSONAS[p]) throw new Error(`no persona "${p}"; use ${Object.keys(PERSONAS).join(', ')}`);
  for (const a of o.accent) if (!VOICES[a]) throw new Error(`no accent "${a}" in bench/voices.json; use ${Object.keys(VOICES).join(', ')}`);
  for (const p of o.pace) if (!PACES[p]) throw new Error(`no pace "${p}"; use ${Object.keys(PACES).join(', ')}`);
  if (!(o.maxMinutes > 0 && o.maxMinutes <= 3)) throw new Error('--max-minutes is more than 0 and at most 3');
  if (!(o.runMinutes > 0 && o.runMinutes <= 15)) throw new Error('--run-minutes is more than 0 and at most 15');
  // H3 (Astra H-human 4): "Infinity" or a huge number would lift the speech cap; a whole number, 1 to 6,000, as bench/hear.mjs.
  if (!(Number.isInteger(o.maxChars) && o.maxChars > 0 && o.maxChars <= MAX_CHARS)) throw new Error(`--max-chars is a whole number from 1 to ${MAX_CHARS} (at most 6000)`);
  return o;
}

const localToday = (tz, now = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);

/** The calls a run makes: each persona once, its accent and pace from the flags in turn (or its own accent, the paces in turn). */
export function planCalls(o, line, today) {
  const personas = o.persona.length ? o.persona : Object.keys(PERSONAS);
  return personas.map((id, i) => {
    const accent = o.accent.length ? o.accent[i % o.accent.length] : PERSONAS[id].accent;
    const pace = o.pace.length ? o.pace[i % o.pace.length] : PACE_ORDER[i % PACE_ORDER.length];
    const truth = personaTruth(id, line, today);
    return { persona: id, accent, voice: VOICES[accent].voice, voiceName: VOICES[accent].name, pace, truth, system: callerPrompt(id, truth, line) };
  });
}

/** For the pace that stops mid-number: the words split after the first group of a spoken or written number. */
export function pauseSplit(text) {
  const d = '(?:zero|oh|one|two|three|four|five|six|seven|eight|nine|double \\w+|\\d)';
  const m = new RegExp(`\\b${d}(?:[ -]${d}){2},?(?=\\s+${d}(?:[ ,.-]+${d}){2,})`, 'i').exec(text);
  if (!m) return [text];
  const cut = m.index + m[0].length;
  return [text.slice(0, cut).trim(), text.slice(cut).trim()].filter(Boolean);
}

/** A thing the agent says while it works: the caller waits instead of answering. */
// H2 (7 Oct 2026): the line tools now speak first (pre_tool_speech force), so a few words like
// "Let me read that back." or "Okay, pencilling that in." come before the tool's answer.
export const AGENT_WORKING = /^(?!.*\?)(?=.*\b(let me (check|see|look|pull|get|read|pencil|put|note|grab|write|jot|send)|one (moment|sec(ond)?)|just a (moment|sec(ond)?)|give me a (moment|sec(ond)?)|hang on|hold on|bear with me|checking|pencilling|penciling|looking)\b)/i;

const HELLO = 'Hello? Are you still there?';

export function dryText(o, line, calls) {
  const out = [];
  out.push(`BENCH, DRY RUN: nothing is sent and no key is read. --live would make ${calls.length} call(s) to ${o.livekit ? `the LiveKit receptionist (livekit/agent.py, a room a call; the caller's voice from Cartesia account ${o.account.toUpperCase()})` : `agent ${o.agent} on Cartesia account ${o.account.toUpperCase()}`} (line facts and stock lines from ${line.id}/line.json).`);
  out.push(`Caps: ${o.maxMinutes} min a call, ${o.runMinutes} min the run (at $0.06 a minute at most $${(0.06 * o.runMinutes).toFixed(2)}); at most ${o.maxChars} TTS characters.`);
  out.push(`Before the first call: GET ${API}/agents/${o.agent} (its name; a Luterson agent is refused, and it must be "${line.agent}", the ${line.id} line's own agent).`);
  for (const [i, c] of calls.entries()) {
    out.push('');
    out.push(`Call ${i + 1}: persona ${c.persona} (${c.truth.name}, wants ${c.truth.wants}), accent ${c.accent} = ${c.voiceName} ${c.voice}, pace ${c.pace} (${PACES[c.pace].why}).`);
    out.push(`  truth: ${JSON.stringify(c.truth)}`);
    out.push(`  1. POST ${API}/tts/bytes "${HELLO}" (the nudge, if the agent goes quiet): ${JSON.stringify(ttsRequest(HELLO, c.voice, PACES[c.pace].speed))}`);
    out.push(`  2. open ${WS_BASE}/${o.agent}?cartesia_version=${VERSION} (header X-API-Key), session_create pcm_16000, audio every 40 ms`);
    out.push(`  3. after each agent turn: POST ${MODEL_URL}/chat/completions (${MODEL}, reasoning low, JSON {say, hangUp}) with this brief, then POST /tts/bytes of its words${c.pace === 'pause' ? ' (a number split in two with 1.5 s of silence between)' : ''}:`);
    for (const l of c.system.split('\n')) out.push(`       | ${l}`);
    out.push(`  4. GET ${API}/agents/calls/<call id> (agent_turn_ms, tool calls), then the human score; saved to out/bench/.`);
  }
  out.push('');
  out.push('Nothing was sent.');
  return out.join('\n');
}

/** The receptionist's read-back of the caller's number, checked digit by digit for the caller's model (SUB05 run s8: the
 * local model kept saying "No, that's not right" to a right read-back until the call ran out). "" when no number was read. */
export function readBackNote(agentText, number) {
  const heard = spokenDigits(agentText);
  if (!number || heard.length < 7) return '';
  return heard.includes(number)
    ? '\n[For you only, checked digit by digit: that read-back is exactly your number. It is right: say yes.]'
    : '\n[For you only, checked digit by digit: that read-back is NOT your number. Say it again.]';
}

/** sq1 (r1 Diwakar: "four two five five five five zero two four", twice, for 4255550247): a caller line that says a whole
 * number (7+ digits) which is not the caller's own; the bench asks its caller model again, as a person knows their number. */
export function numberSlip(say, number) {
  const d = spokenDigits(say);
  return Boolean(number) && d.length >= 7 && d !== number && !(d.length === 7 && number.endsWith(d));   // the last seven alone: a local number
}

/** sq1: the letters a line spells (runs of three or more single letters: "S, I, O, B, H, A, N ... K, E, L, L, Y" -> "SIOBHANKELLY"). */
export function spelledLetters(text) {
  const runs = String(text || '').match(/(?:(?<![A-Za-z'’])[A-Za-z](?![A-Za-z'’])[\s.,…-]*){3,}/g) || [];
  return runs.map((r) => r.replace(/[^A-Za-z]/g, '')).join('').toUpperCase();
}

/** sq1: the receptionist's spelled read-back of the caller's name ("S-I-O-B-H-A-N K-E-L-L"), checked letter by letter for the caller's
 * model, as a person hears their own name spelled. "" when no name was spelled back. */
export function nameReadBackNote(agentText, name) {
  const runs = String(agentText || '').match(/\b(?:[A-Za-z]-){2,}[A-Za-z]\b/g) || [];
  // sq2 (f11: "Sure. J, R, Z, Y, S, Z, T, O, F, N, O, W, A, K." went unchecked, the caller said nothing and the card said
  // "Jrzysztof"): letters read back with commas or spaces are checked too, as a person hears them
  const got = runs.length ? runs.join('').replace(/-/g, '').toUpperCase() : spelledLetters(agentText);
  if (!name || !got) return '';
  const words = String(name).toUpperCase().split(/\s+/);
  return got === words.join('') || words.includes(got)
    ? '\n[For you only, checked letter by letter: that spelling of your name is exactly right.]'
    : `\n[For you only, checked letter by letter: that spelling is NOT your name (${name}): say no and spell it again.]`;
}

/** sq1: a spelled line in the caller's voice, rendered again (3 takes at most) when Deepgram's pre-recorded model hears fewer letters
 * than the line spells. Measured 11 Oct 2026: the Aura-2 caller voice sometimes leaves out a line's last letters ("K, E, L, L, Y"
 * said as "k e l"; Flux and Nova-3 heard the same letters in 16 of 16 takes, and the short takes were the ones missing letters):
 * a real caller says every letter. Returns the pcm and what the check heard. */
export async function checkedSpelling({ text, render, hear, tries = 3, together = 2 }) {
  const want = spelledLetters(text);
  if (!want) return { pcm: await render(), takes: 1 };
  // f1: one take after another kept the caller quiet 11 s (Krzysztof: "Are you still there?"); two at once cost one wait
  const one = async () => { const pcm = await render(); return { pcm, got: spelledLetters(await hear(pcm).catch(() => '')) }; };
  let takes = 0; let first = null;
  while (takes < tries) {
    const started = Array.from({ length: Math.min(together, tries - takes) }, one);
    takes += started.length;
    // f2: the first good take of the pair is said at once, not after the slower one (Xiomara 10.8 s drew "Are you still there?")
    const ok = await new Promise((resolve) => {
      let left = started.length;
      const done = () => { if (--left === 0) resolve(null); };
      for (const p of started) p.then((b) => (b.got === want ? resolve(b) : done()), done);
    });
    if (ok) return { pcm: ok.pcm, takes, want, got: ok.got };
    const batch = await Promise.all(started);   // none was right: a failed render throws here as itself
    first ||= batch[0];
  }
  return { pcm: first.pcm, takes, want, got: first.got };
}

/** sq1 (f2): the stop between a spelled line's words and its letters (each part's own edge silence is cut first). */
export const SPELL_GAP_MS = 350;

/** sq1 (f2): a spelled line's words before the letters and the letters, as two parts that render at once ("My name is Xiomara
 * Delgado." | "X, I, O, M, A, R, A" | "D, E, L, G, A, D, O."). A spelled line took 5.2-6.6 s to render whole (Deepgram Aura-2,
 * 11 Oct 2026), so the caller's spelling came after the receptionist's 8 s check-in. One part when nothing comes before the
 * letters or the words before them do not end in a stop or a comma. */
export function spelledParts(text) {
  const s = String(text || '');
  const m = /(?:(?<![A-Za-z'’])[A-Za-z](?![A-Za-z'’])[\s.,…-]*){3,}/.exec(s);
  if (!m) return [s];
  const head = m.index ? /^(.*[.!?,:;—-])\s+$/s.exec(s.slice(0, m.index)) : null;
  const letters = s.slice(m.index).split(/\s*(?:\.\.\.|…)\s*/).filter((x) => /[A-Za-z]/.test(x));
  if (!head || head[1].trim().split(/\s+/).length < 2) return letters.length > 1 ? letters : [s];
  return [head[1].trim(), ...letters];
}

/** The stops between spelledParts' parts: words to letters SPELL_GAP_MS, first name's letters to the last name's NAME_GAP_MS. */
export const NAME_GAP_MS = 600;
export function spelledGaps(parts) {
  return parts.slice(1).map((p, i) => (i === 0 && spelledLetters(parts[0]) === '' ? SPELL_GAP_MS : NAME_GAP_MS));
}

/** sq1: Deepgram's pre-recorded hearing (Nova-3) of 16 kHz pcm, with the bench caller's key (BENCH_DEEPGRAM_KEY, default "2"). */
export async function hearPcm(pcm, { fetchImpl = fetch } = {}) {
  const key = readFileSync(`${process.env.HOME}/ethan/secrets/deepgram/${process.env.BENCH_DEEPGRAM_KEY || '2'}`, 'utf8').trim();
  const res = await fetchImpl('https://api.deepgram.com/v1/listen?model=nova-3&encoding=linear16&sample_rate=16000&punctuate=true', {
    method: 'POST', headers: { Authorization: `Token ${key}`, 'Content-Type': 'audio/raw' }, body: pcm, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`pre-recorded hearing answered ${res.status}`);
  return (await res.json()).results?.channels?.[0]?.alternatives?.[0]?.transcript || '';
}

/** The caller's next words from the local model: {say, hangUp}. */
export async function callerTurn({ system, history, modelKey, fetchImpl = fetch }) {
  const messages = [{ role: 'system', content: system }, ...history];
  const schema = { type: 'object', additionalProperties: false, required: ['say', 'hangUp'], properties: { say: { type: 'string' }, hangUp: { type: 'boolean' } } };
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetchImpl(`${MODEL_URL}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${modelKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: MODEL, messages, temperature: 0.7, reasoning_effort: 'low', max_tokens: 2000,
          response_format: { type: 'json_schema', json_schema: { name: 'caller', strict: true, schema } } }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) throw new Error(`the local model answered ${res.status}`);
      const r = JSON.parse((await res.json()).choices[0].message.content);
      const say = String(r.say || '').replace(/<\|[^|]*\|>/g, '').trim();
      if (!say) throw new Error('the local model said nothing');
      return { say, hangUp: Boolean(r.hangUp) };
    } catch (err) {
      if (attempt >= 1) throw err;
    }
  }
}

/** The bench record of one call (the shape bench/human-score.mjs reads). */
export function benchRecord({ call, result, callerSaid, agent, account, cartesia = null }) {
  return {
    kind: 'bench', at: new Date().toISOString(), agent, account, callId: result.callId,
    persona: call.persona, accent: call.accent, voice: call.voice, pace: call.pace, truth: call.truth,
    seconds: result.seconds, closedBy: result.closedBy, error: result.error,
    // HW2 (9 Oct 2026): ms = the caller's last real sound on the wire to the receptionist's first real sound back (nothing
    // subtracted); split = the agent's own clocks for that wait (toVadEnd: last sound to the agent's end of speech, agent:
    // to its first sound out, down: to the first sound back at the caller), null on a Cartesia call.
    gaps: result.firstAudioMs.map((f) => ({ ms: f.msAfterAudioEnd, afterCallerLine: f.afterCallerLine, msAfterTurnEnded: f.ms, wall: f.wall, wallAudioEnd: f.wallAudioEnd, track: f.track, faintMs: f.faintMs, peak: f.peak, ...(f.split ? { split: f.split } : {}) })),
    ...(result.pacing ? { pacing: result.pacing } : {}),
    ...(result.overTalk ? { overTalk: result.overTalk } : {}),
    sayLog: result.sayLog || [],
    turns: result.turns.map((t) => ({ role: t.role, text: t.text, tool_calls: t.tool_calls, interrupted: t.interrupted, at: t.at, ...(t.role === 'assistant' ? { audioMs: t.audioMs, pauseMs: t.pauseMs } : {}) })),
    callerSaid, cartesia,
  };
}

/** One live call. Spends agent minutes, TTS characters and local-model time. */
export async function liveCall({ call, o, key, modelKey, spend, maxSeconds, log = console.log }) {
  const pace = PACES[call.pace];
  const trimmed = [];
  // H2: the silence TTS puts around the words is cut, so the gap starts at the caller's last word.
  const say = async (text) => {
    const spelled = spelledParts(text);
    const render = () => (spelled.length > 1 ? speakParts({ parts: spelled, pauseMs: spelledGaps(spelled), trim: true, key, voice: call.voice, speed: pace.speed, spend })
      : PHONE && !pace.pauseMs && midSplit(text) ? (process.env.BENCH_SPLIT_PARTS === '1'
        ? speakParts({ parts: midSplit(text), pauseMs: 350 + Math.round(Math.random() * 300), trim: true, key, voice: call.voice, speed: pace.speed, spend })
        : speak({ key, text, voice: call.voice, speed: pace.speed, spend }).then((p) => insertPause(trimSilence(p).pcm, 350 + Math.round(Math.random() * 300), SAMPLE_RATE)))   // sm7l
      : pace.pauseMs ? speakParts({ parts: pauseSplit(text), pauseMs: pace.pauseMs, key, voice: call.voice, speed: pace.speed, spend })
        : speak({ key, text, voice: call.voice, speed: pace.speed, spend }));
    const checked = process.env.BENCH_CHECK_SPELLING === '0' ? { pcm: await render(), takes: 1 } : await checkedSpelling({ text, render, hear: hearPcm });
    if (checked.want) log(`  caller voice: ${checked.takes} take(s) for "${checked.want}"${checked.got === checked.want ? '' : ` (still heard "${checked.got}")`}`);
    const pcm = PHONE ? phoneBand(checked.pcm) : checked.pcm;   // sm7: the caller heard through a phone line (after the spelling check)
    const t = trimSilence(pcm);
    trimmed.push({ leadMs: t.leadMs, tailMs: t.tailMs });
    return t.pcm;
  };
  const audio = { hello: await say(HELLO), ...(PHONE ? { pickup: await say('Hello?') } : {}) };
  const history = [];
  const callerSaid = [];
  let n = 0;
  // H3 (Astra H-human 3): runCall turns a failed answer into an ordinary call result, so a payment or
  // credit error inside the call is kept here as itself, and the run stops after this call's cleanup.
  let moneyError = null;
  const answerFn = async (agentText, used) => {
    try {
      history.push({ role: 'user', content: agentText + readBackNote(agentText, PERSONAS[call.persona]?.number) + nameReadBackNote(agentText, PERSONAS[call.persona]?.name) });   // the agent's words are the model's "user"
      if (used.has('bye')) return null;
      if (AGENT_WORKING.test(agentText)) return 'wait';
      const t0 = Date.now();
      let r = await callerTurn({ system: call.system, history, modelKey });
      for (let again = 0; again < 2 && numberSlip(r.say, PERSONAS[call.persona]?.number); again++) {
        log(`  caller number slip: "${r.say.slice(0, 80)}" (asked again)`);
        r = await callerTurn({ system: call.system, history, modelKey });
      }
      const tModel = Date.now() - t0;
      history.push({ role: 'assistant', content: r.say });
      if (!spend.canSpeak(r.say)) { log(`  speech limit reached (${spend.chars} characters): the caller hangs up`); return null; }
      const id = r.hangUp ? 'bye' : `t${++n}`;
      audio[id] = await say(r.say);
      log(`  caller time: model ${tModel} ms, voice ${Date.now() - t0 - tModel} ms`);   // sq1: a slow caller turn draws "Are you still there?"
      callerSaid.push({ id, text: r.say });
      return id;
    } catch (err) {
      if (err instanceof MoneyError && !moneyError) moneyError = err;
      throw err;
    }
  };
  const result = o.livekit
    ? await runRoomCall({ trade: call.persona, roomName: `bench-${call.persona}-${Date.now().toString(36)}`, audio, maxSeconds, answerFn, log: (m) => log(`  ${m}`) })
    : await runCall({ trade: call.persona, agentId: o.agent, openSocket: (url) => new WebSocket(url, { headers: { 'X-API-Key': key } }),
      audio, maxSeconds, answerFn, log: (m) => log(`  ${m}`) });
  return { result, callerSaid, trimmed, moneyError };
}

/**
 * H2 (live only): the persona's dates moved, if need be, to working days the line's live calendar says
 * are free (the site's check route, which holds nothing), so a date pencilled in by an earlier bench call
 * does not turn a booking call into a "not free" call. Returns the truth with free dates.
 */
export async function freeOnSite({ truth, line, lineKey, site = process.env.BENCH_SITE || SITE, fetchImpl = fetch }) {
  const isFree = async (iso) => {
    const res = await fetchImpl(`${site}/api/line/${line.id}/check`, { method: 'POST', headers: { 'X-Line-Key': lineKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: iso, weekday: new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' }), said: iso }) });
    if (!res.ok) throw new Error(`the site's check route answered ${res.status}`);
    const j = await res.json();
    return j.free === iso;
  };
  const days = workDaysOf(line);
  const next = (iso) => {   // the next working day of the line
    const d = new Date(`${iso}T12:00:00Z`);
    do d.setUTCDate(d.getUTCDate() + 1); while (!days.includes(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()]));
    return d.toISOString().slice(0, 10);
  };
  const out = { ...truth };
  const taken = new Set();
  for (const k of ['firstDate', 'date']) {
    if (!out[k]) continue;
    let iso = out[k];
    for (let i = 0; i < 20 && (taken.has(iso) || !(await isFree(iso))); i++) iso = next(iso);
    out[k] = iso; taken.add(iso);
  }
  return out;
}

/**
 * H2 (7 Oct 2026): let go of the dates a bench call pencilled in. Every bench call reaches the site from
 * the same websocket (no caller number), and the site keeps at most 5 live holds a day on a line
 * (HOLDS_PER_DAY): four bench bookings on 7 Oct filled the Harbor test line's day, and the live dashboard
 * check could not hold. The same route and body as the line's own release. Returns what it let go.
 */
export async function releaseBenchHolds({ rec, line, lineKey, site = process.env.BENCH_SITE || SITE, fetchImpl = fetch }) {
  const turns = rec.cartesia?.transcript || rec.turns || [];
  const held = [];
  for (const t of turns) for (const c of t.tool_calls || []) {
    if (c.name !== line.hold || c.arguments?.action === 'release') continue;
    let r; try { r = JSON.parse(c.result || '{}'); } catch { r = {}; }
    if (r.ok && r.held && !held.includes(r.held)) held.push(r.held);
  }
  const out = [];
  for (const date of held) {
    const res = await fetchImpl(`${site}/api/line/${line.id}/book`, { method: 'POST', headers: { 'X-Line-Key': lineKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ callId: rec.callId, action: 'release', date }) });
    const j = res.ok ? await res.json().catch(() => ({})) : {};
    out.push({ date, released: res.ok && j.released === date, status: res.status });
  }
  return out;
}

/** What main reaches outside with (H3: tests hand in fakes; nothing here is read or sent in a dry run). */
export const IO = { benchKey, readKey, checkAgentName: (a) => checkAgentName(a), liveCall: (a) => liveCall(a), freeOnSite: (a) => freeOnSite(a), fetchCall: (...a) => fetchCall(...a), releaseBenchHolds: (a) => releaseBenchHolds(a), pause: (ms) => new Promise((r) => setTimeout(r, ms)), outDir: null };

export async function main(argv, { log = console.log, now = new Date(), io: given = {} } = {}) {
  const io = { ...IO, ...given };
  const o = parseArgs(argv);
  const { line } = readLine(o.line);
  refuseLine(line);   // H3: before any key is read, dry or live
  const lutersonAgentName = readLine('luterson').line.agent;
  if (o.livekit) { benchAccount(o.account); o.agent = `livekit:${line.id}`; }   // HW: no Cartesia agent; the line is a test line (refuseLine above)
  else if (o.live || o.agent) refuseTarget({ account: o.account, agent: o.agent, lutersonAgentName });
  else { benchAccount(o.account); o.agent = '<agent id>'; }
  const today = o.today || localToday(line.timezone || 'America/Los_Angeles', now);
  const calls = planCalls(o, line, today);
  if (!o.live) { log(dryText(o, line, calls)); return { dry: true, calls }; }

  const key = io.benchKey(o.account);
  // H3: the agent is the line's own before the line's key is read.
  const name = o.livekit ? 'the LiveKit receptionist (livekit/agent.py)' : await io.checkAgentName({ key, agent: o.agent, lutersonAgentName, lineAgent: line.agent, lineId: line.id });
  const modelKey = io.readKey('llm-api-key');
  if (!modelKey) throw new Error('the local model key (~/ethan/secrets/llm-api-key) is missing');
  const lineKey = line.keyFile ? io.readKey(line.keyFile) : '';
  log(`Agent ${o.agent} "${name}" on account ${o.account.toUpperCase()}.`);
  const spend = new Spend({ maxChars: o.maxChars, maxHeardSeconds: Infinity });
  const outDir = io.outDir || join(HERE, '..', 'out', 'bench');
  mkdirSync(outDir, { recursive: true });
  let used = 0;
  let stopped = '';   // H3: the payment or credit error that stopped the run
  const scores = [];
  for (const call of calls) {
    const left = o.runMinutes * 60 - used;
    if (left < 30) { log(`Run cap of ${o.runMinutes} min reached; ${calls.length - scores.length} call(s) not made.`); break; }
    if (call.truth.date && lineKey) {
      const truth = await io.freeOnSite({ truth: call.truth, line, lineKey });
      if (truth.date !== call.truth.date || truth.firstDate !== call.truth.firstDate) { call.truth = truth; call.system = callerPrompt(call.persona, truth, line); }
    }
    log(`\nCall: ${call.persona} / ${call.accent} / ${call.pace}${call.truth.date ? ` (date ${call.truth.date})` : ''}`);
    let got;
    try {
      got = await io.liveCall({ call, o, key, modelKey, spend, maxSeconds: Math.min(o.maxMinutes * 60, left), log });
    } catch (err) {
      if (err instanceof MoneyError) { log(err.message); stopped = err.message; break; }
      throw err;
    }
    used += got.result.seconds;
    const rec = benchRecord({ call, ...got, agent: o.agent, account: o.account });
    rec.trimmed = got.trimmed;
    if (o.livekit) rec.livekit = { session: got.result.livekit, metrics: got.result.metrics || [] };   // HW: the agent's own timing per turn
    if (got.moneyError) rec.moneyError = got.moneyError.message;
    if (rec.callId && !o.livekit) {
      await io.pause(5000);
      try { rec.cartesia = await io.fetchCall(rec.callId, { line: { id: 'bench', cartesiaAccount: o.account } }); } catch (err) { rec.cartesiaError = err.message; }
    }
    if (!o.keepHolds && lineKey && rec.callId) {
      try { rec.released = await io.releaseBenchHolds({ rec, line, lineKey }); } catch (err) { rec.released = [{ error: err.message }]; }
      if (rec.released.length) log(`  let go of the bench's pencilled-in date(s): ${rec.released.map((x) => `${x.date} ${x.released ? 'freed' : `NOT freed (${x.status ?? x.error})`}`).join(', ')} (--keep-holds keeps them)`);
    }
    const s = humanScore(rec, { lineId: line.id });
    rec.score = { total: s.total, closeToHuman: s.closeToHuman, parts: s.parts.map((p) => ({ key: p.key, ours: p.ours, score: p.score })) };
    const file = join(outDir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${call.persona}.json`);
    writeFileSync(file, `${JSON.stringify(rec, null, 1)}\n`);
    log(scoreText(s));
    log(`saved ${file}`);
    scores.push({ persona: call.persona, accent: call.accent, pace: call.pace, callId: rec.callId, seconds: Math.round(got.result.seconds), total: s.total });
    // H3: a payment or credit error in the call stops the run here, after the call's record and clean-up.
    if (got.moneyError) { log(got.moneyError.message); stopped = got.moneyError.message; break; }
  }
  log(`\nRun: ${scores.length} call(s), ${(used / 60).toFixed(1)} agent minutes; ${spend.text()}.`);
  for (const s of scores) log(`  ${s.persona} / ${s.accent} / ${s.pace}: ${s.total ?? 'n/a'}/100 (${s.seconds} s, ${s.callId})`);
  return { dry: false, scores, spend, ...(stopped ? { stopped } : {}) };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).catch((err) => { console.error(`bench: ${err.message}`); process.exitCode = 2; })
    .finally(() => setTimeout(() => process.exit(process.exitCode || 0), 500));   // the room's native side keeps node alive after a LiveKit call
}
