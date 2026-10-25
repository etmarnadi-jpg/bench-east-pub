// HW (8 Oct 2026): a test call to the LiveKit receptionist (livekit/agent.py), the way lib/testcall.mjs
// runCall calls a Cartesia agent: the bench joins a LiveKit room as the caller, sends its caller audio
// (16 kHz PCM) and measures the gap from the last chunk of a caller line to the first agent sound back.
// The agent's words, what it heard and its tool calls come back as json text on topic "bench".
// Returns the same result shape as runCall: { callId, seconds, closedBy, error, turns, firstAudioMs, said, sayLog }.
//
// HW2 (9 Oct 2026), the bench tells the truth: the gap runs from the caller's LAST REAL SOUND as it leaves
// the caller (the moment that sample goes out on the caller's track, the room's send queue counted) to the
// receptionist's FIRST REAL SOUND as it reaches the caller (the sample's position inside the received frame
// counted). Nothing is subtracted. The caller's frames are sent on a schedule and catch up after a late tick,
// so a busy moment never slips silence into a caller line. Beside the gap, the agent's own clocks (the same
// machine's wall clock) say how the wait splits: caller's last sound -> the agent's end of speech -> the agent's
// first sound out -> the first sound back at the caller. bench/loopback.mjs proves the measure with a known delay.
import { Room, RoomEvent, AudioSource, LocalAudioTrack, AudioStream, AudioFrame, TrackSource, TrackKind } from '@livekit/rtc-node';
import { AccessToken, RoomConfiguration, RoomAgentDispatch } from 'livekit-server-sdk';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { chunks, SAMPLE_RATE, CHUNK_MS, MAX_SECONDS } from './testcall.mjs';
import { PHONE, makeLineNoise } from './phone.mjs';

const SECRETS = join(homedir(), 'ethan', 'secrets');
export const readSecret = (name) => readFileSync(join(SECRETS, name), 'utf8').trim();
// 13 Oct 2026 (Ethan gave a third LiveKit account for tests and the demo): HW_LK_KEYS names the key files the test caller
// uses (<prefix>-url/-api-key/-api-secret); tests use livekit3, never livekit (Luterson's number and rooms).
const LK = process.env.HW_LK_KEYS || 'livekit';

/** The caller's room token (the room is made on join; the agent worker is sent to every new room). */
export async function callerToken({ room, apiKey = readSecret(`${LK}-api-key`), apiSecret = readSecret(`${LK}-api-secret`), identity = 'caller', canPublish = true }) {
  const at = new AccessToken(apiKey, apiSecret, { identity, ttl: '15m' });
  at.addGrant({ roomJoin: true, room, canPublish, canSubscribe: true, roomCreate: true });
  // the cloud receptionist is asked for by name (LiveKit Cloud names every deployed agent; the east bench's patch-dispatch.py, now here)
  if (process.env.BENCH_AGENT_NAME) at.roomConfig = new RoomConfiguration({ agents: [new RoomAgentDispatch({ agentName: process.env.BENCH_AGENT_NAME })] });
  return at.toJwt();
}

/**
 * S2 bv2-wire (24 Oct 2026): what the caller heard and said, recorded on the bench clock (seconds since the call started, the
 * clock of sayLog.at). One lane a track: the agent's tracks by name ("clips", "voice") and the caller's own frames as they went
 * out. A frame is placed where it arrived (agent) or went out on the wire (caller); frames that follow on within GAP_MS go on
 * end to end (the audio's own clock), a later one starts a new stretch at its own time with silence before it. Several
 * subscriptions of one name (the clip track renewed) mix into one lane. On when BENCH_RECORD=1.
 */
export const RECORD = process.env.BENCH_RECORD === '1';
export const GAP_MS = 40;
export class CallRecorder {
  constructor({ rate = SAMPLE_RATE, gapMs = GAP_MS } = {}) { this.rate = rate; this.gap = Math.round((rate * gapMs) / 1000); this.lanes = new Map(); }
  /** A writer for one subscription of a lane: push(int16, atSec). */
  writer(key, name = key) {
    let lane = this.lanes.get(key);
    if (!lane) { lane = { key, names: new Set(), parts: [], maxAheadMs: 0 }; this.lanes.set(key, lane); }
    lane.names.add(name);
    let next = null;
    return {
      push: (int16, atSec) => {
        const p = Math.round(atSec * this.rate);
        const pos = next === null || p > next + this.gap || p < next - 30 * this.rate ? p : next;
        if (next !== null && pos === next && next > p) lane.maxAheadMs = Math.max(lane.maxAheadMs, Math.round(((next - p) * 1000) / this.rate));
        lane.parts.push({ pos, data: int16 });
        next = pos + int16.length;
      },
    };
  }
  /** One lane (or several mixed) as {t0 (s), int16}; null when nothing was recorded. */
  render(keys) {
    const parts = [].concat(...[].concat(keys).map((k) => this.lanes.get(k)?.parts || []));
    if (!parts.length) return null;
    const lo = Math.min(...parts.map((x) => x.pos));
    const hi = Math.max(...parts.map((x) => x.pos + x.data.length));
    const acc = new Int32Array(hi - lo);
    for (const { pos, data } of parts) for (let i = 0; i < data.length; i++) acc[pos - lo + i] += data[i];
    const out = new Int16Array(acc.length);
    for (let i = 0; i < acc.length; i++) out[i] = Math.max(-32768, Math.min(32767, acc[i]));
    return { t0: lo / this.rate, int16: out };
  }
}

/** 16-bit mono PCM as a WAV file. */
export function wavOf(int16, rate = SAMPLE_RATE) {
  const data = Buffer.from(int16.buffer, int16.byteOffset, int16.length * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

/** The call's WAVs next to its JSON (<base>.agent-voice.wav, .agent-clips.wav, .heard.wav, .caller.wav); returns the JSON's
 * `audio` list: [{track, file (name only, beside the JSON), t0 (bench clock s), names, seconds, maxAheadMs}]. */
export function writeRecording(rec, base, { write = writeFileSync } = {}) {
  if (!rec) return [];
  const out = [];
  const agentKeys = [...rec.lanes.keys()].filter((k) => k !== 'caller');
  const one = (track, keys, file) => {
    const r = rec.render(keys);
    if (!r) return;
    write(`${base}.${file}.wav`, wavOf(r.int16, rec.rate));
    const lanes = [].concat(keys).map((k) => rec.lanes.get(k)).filter(Boolean);
    out.push({ track, file: `${base.split('/').pop()}.${file}.wav`, t0: Math.round(r.t0 * 1000) / 1000, names: [...new Set(lanes.flatMap((l) => [...l.names]))],
      seconds: Math.round((r.int16.length / rec.rate) * 1000) / 1000, maxAheadMs: Math.max(0, ...lanes.map((l) => l.maxAheadMs)) });
  };
  for (const k of agentKeys) one(k, k, `agent-${k}`);
  if (agentKeys.length) one('heard', agentKeys, 'heard');
  one('caller', 'caller', 'caller');
  return out;
}

export const SILENT_MAX = 300;   // a sample above this is sound (the agent's track may carry silence)
/** True when any sample of the frame is sound (every 4th sample is looked at: enough for speech). */
export const loud = (int16) => { for (let i = 0; i < int16.length; i += 4) { const v = int16[i]; if (v > SILENT_MAX || v < -SILENT_MAX) return true; } return false; };
/** The index of the first sound sample, or -1. */
export const FAINT_MAX = 40;   // a sample above this is a faint sound (a soft consonant before the bench's loud line)
export const firstFaint = (int16) => { for (let i = 0; i < int16.length; i++) { const v = int16[i]; if (v > FAINT_MAX || v < -FAINT_MAX) return i; } return -1; };
export const peakOf = (int16) => { let m = 0; for (let i = 0; i < int16.length; i++) { const v = int16[i] < 0 ? -int16[i] : int16[i]; if (v > m) m = v; } return m; };
export const firstLoud = (int16) => { for (let i = 0; i < int16.length; i++) { const v = int16[i]; if (v > SILENT_MAX || v < -SILENT_MAX) return i; } return -1; };
/** The index of the last sound sample, or -1. */
/** sm8e: how long the caller's own line stays quiet from fromMs on (ms; the rest of the line when it never sounds again): an agent
 * sound in an overTalk that ends sooner was said in the caller's pause, not over them. */
export const quietAhead = (pcm, fromMs) => {
  if (!pcm || fromMs === null || fromMs < 0) return null;
  const int16 = new Int16Array(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.length - (pcm.length % 2)));
  const start = Math.floor((fromMs * SAMPLE_RATE) / 1000);
  for (let i = Math.max(0, start); i < int16.length; i++) { const v = int16[i]; if (v > SILENT_MAX || v < -SILENT_MAX) return Math.round(((i - start) * 1000) / SAMPLE_RATE); }
  return Math.round(((int16.length - start) * 1000) / SAMPLE_RATE);
};
export const lastLoud = (int16) => { for (let i = int16.length - 1; i >= 0; i--) { const v = int16[i]; if (v > SILENT_MAX || v < -SILENT_MAX) return i; } return -1; };

/**
 * A caller line as frames for the room: base64 chunks of chunkMs, and on the chunk that carries the last
 * sound, how many ms into the chunk that sound ends (null on every other chunk). The last chunk is marked.
 */
export function lineFrames(pcm, chunkMs = CHUNK_MS) {
  const int16 = new Int16Array(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.length - (pcm.length % 2)));
  const last = lastLoud(int16);
  const perChunk = (SAMPLE_RATE * chunkMs) / 1000;
  const lastChunk = last < 0 ? -1 : Math.floor(last / perChunk);
  return chunks(pcm, chunkMs).map((b64, i, all) => ({
    b64,
    lastSoundMs: i === lastChunk ? ((last - lastChunk * perChunk + 1) * 1000) / SAMPLE_RATE : null,
    last: i === all.length - 1,
  }));
}

/** The agent's end_call leaves a tool record on the turn it closed with, so the scorer's "hung up on a question" check
 * sees it (Astra HW2 finding 9): on the last assistant turn, or with the pending tools when that turn is still to come. */
export function noteEndCall(turns, pendingTools) {
  const rec = { name: 'end_call', arguments: {}, result: 'The call has ended.', ms: 0, status: 'ok' };
  const last = turns.at(-1);
  if (last && last.role === 'assistant') last.tool_calls.push(rec); else pendingTools.push(rec);
  return rec;
}

/** sq1 (f2): whether the caller answers this agent turn. Not a line the caller cut off ("Okay. And what's the": the caller's own
 * line is under way and the agent speaks again after it; answering it doubled Siobhan's number), and not a check-in ("Are you
 * still there?") while the caller's answer is still being made (that dropped Xiomara's spelled name: a slow person answers the
 * question they were asked). */
export const CHECK_IN = /\bstill there\b/i;
export function answersTurn(e, preparing) {
  if (e.role !== 'assistant' || e.interrupted) return false;
  return !(preparing && CHECK_IN.test(e.text || ''));
}

export function runRoomCall({ trade, roomName, url = readSecret(`${LK}-url`), audio, maxSeconds = MAX_SECONDS, chunkMs = CHUNK_MS, now = () => Date.now(),
  replyDelayMs = 600, log = () => {}, answerFn = null, waitMs = 12_000, afterSpeechMs = 700, byeMs = 20_000, joinTimeoutMs = 20_000, identity = 'caller',
  record = RECORD, bed = null, ctl = {}, RoomImpl = Room, AudioStreamImpl = AudioStream, AudioSourceImpl = AudioSource, LocalAudioTrackImpl = LocalAudioTrack,
  AudioFrameImpl = AudioFrame, tokenFn = callerToken }) {   // S2: the room's classes handed in by the recorder's test (no network)
  return new Promise((resolve) => {
    const started = now();
    const turns = [];
    const used = new Set();
    const queue = [];
    const firstAudio = [];
    const sayLog = [];
    let session = null;
    let waitingFirstAudio = false;
    let closedBy = null;
    let pending = null;
    let error = null;
    let speechEndsAt = 0;
    let audioEndAt = null;   // when the caller's last sound went out on the track (bench clock)
    let faintAt = null;      // the first faint sound from the agent after that (SUB05)
    let wallAudioEnd = null;
    let agentAudioBytes = 0;
    let longestPause = 0;   // the longest quiet stretch inside the agent's turn (between its sounds; a clip, then its words)
    let lastLoudAt = null;
    let pendingTools = [];
    let askedTurns = 0;      // sq1: the agent turns the caller was asked to answer
    let preparing = false;   // the caller's answer to the last of them is still being made
    const metrics = [];
    const clocks = { vadEnd: null, agentSpeaking: null, clip: null };   // the agent's wall clocks since the caller's last sound
    const pacing = { lateTicks: 0, worstLateMs: 0, sent: 0 };   // how well the caller's frames kept time
    let loudUntil = 0;   // the agent is speaking until this time (pauses inside a sentence count as speech)
    // sq3 (Ethan 12 Oct: nothing said while the caller is still talking): every start of the agent's sound while a caller line is
    // going out (from its first frame on the wire to its last sound), with how long before the line's last sound it came
    const overTalk = [];
    let curLine = null, lineStartAt = null, lineEndAt = null;
    let pump = null;
    const room = new RoomImpl();
    const samplesPerChunk = (SAMPLE_RATE * chunkMs) / 1000;
    const source = new AudioSourceImpl(SAMPLE_RATE, 1);
    // S2: the recording (BENCH_RECORD=1), the caller's room sound (bed: the speakerphone room), the caller's barge-in (ctl.barge)
    const recorder = record ? new CallRecorder() : null;
    const callerLane = recorder ? recorder.writer('caller') : null;
    const benchS = (ms) => (ms - started) / 1000;
    let barge = null;   // {line, dueAt}: the barge line goes out at dueAt (bench ms) if the agent's voice is still going
    let bargeDone = false, bargeEndAt = null;
    let voiceLoudUntil = 0;
    const lineNoise = PHONE ? makeLineNoise() : null;   // sm7: phone mode, every frame carries the line's noise
    let pickedUp = false;
    const finish = async (why) => {
      if (closedBy) return;
      closedBy = why;
      clearInterval(pump);
      clearTimeout(pending);
      try { await room.disconnect(); } catch { /* gone */ }
      resolve({ trade, agentId: `livekit:${roomName}`, callId: session?.callId || roomName, agentVersionId: session?.model || null,
        seconds: (now() - started) / 1000, closedBy: why, error, turns, firstAudioMs: firstAudio, said: [...used], sayLog, livekit: session, metrics, pacing,
        overTalk: overTalk.map(({ soundAt, ...o }) => o), recording: recorder, ...(ctl.barge ? { barge: { ...ctl.barge, said: bargeDone } } : {}) });
    };
    const say = (id) => {
      if (!audio[id]) { log(`caller [${id}] has no audio: the caller hangs up`); return finish('caller hung up'); }
      used.add(id);
      if (id === 'bye' && answerFn) setTimeout(() => finish('caller hung up'), byeMs);
      sayLog.push({ id, at: (now() - started) / 1000, wall: Date.now() });
      const frames = lineFrames(audio[id], chunkMs).map((f) => ({ ...f, lineId: id }));
      if (frames.length) frames[0] = { ...frames[0], lineStart: id };
      curLine = id; lineStartAt = null; lineEndAt = null;
      queue.push(...frames);
      log(`caller [${id}]`);
    };
    const reply = (next) => {
      clearTimeout(pending);
      if (next === null) { pending = setTimeout(() => finish('caller hung up'), 1500); return; }
      const delay = () => Math.max(replyDelayMs, speechEndsAt - now() + afterSpeechMs);
      if (next === 'wait') {
        const nudge = audio.hello && !used.has('hello') ? 'hello' : used.has('bye') || !audio.bye ? null : 'bye';
        const armedAt = now();
        const fire = () => {
          // HW (8 Oct 2026): never talk over the receptionist: while it still speaks (or just stopped), wait on, 30 s at most in all.
          if (Math.max(speechEndsAt, loudUntil) + afterSpeechMs > now() && now() - armedAt < 30_000) { pending = setTimeout(fire, delay()); return; }
          if (nudge) say(nudge); else finish('caller hung up');
        };
        pending = setTimeout(fire, Math.max(waitMs, delay()));
        return;
      }
      pending = setTimeout(() => say(next), delay());
    };
    const onEvent = (e) => {
      const t = (now() - started) / 1000;
      if (e.type === 'ready') { session = e; log(`session ${e.callId} (model ${e.model}, turn ${e.turn}, delay ${e.minDelay}-${e.maxDelay} s, vad ${e.vadSilence} s, preemptive ${e.preemptive}, clip ${e.clip})`); return; }
      if (e.type === 'tool') { pendingTools.push({ name: e.name, arguments: e.arguments, result: e.result, ms: e.ms, status: e.status, at: t - (Number(e.ms) || 0) / 1000 }); log(`tool ${e.name} ${e.ms} ms ${e.status}`); return; }   // at: when the tool started (SUB05)
      const wallMs = e.wall ? (e.wall < 1e11 ? e.wall * 1000 : e.wall) : null;   // the agent stamps seconds (time.time()); the bench ms
      if (e.type === 'state' && waitingFirstAudio && wallMs) {   // the agent's clocks for the wait under way
        if (e.user === 'listening' && clocks.vadEnd === null) clocks.vadEnd = wallMs;
        if (e.agent === 'speaking' && clocks.agentSpeaking === null) clocks.agentSpeaking = wallMs;
      }
      if (e.type === 'clip' && waitingFirstAudio && wallMs && clocks.clip === null) clocks.clip = wallMs;
      if (e.type === 'clip' || e.type === 'clipcheck' || e.type === 'state' || e.type === 'final') { metrics.push({ ...e, at: t }); if (e.type === 'clip') log(`clip${e.early ? ' (early)' : ''}: ${e.text}`); return; }
      if (e.type === 'metrics') { metrics.push({ ...e, at: t }); return; }
      if (e.type === 'heard') return;
      if (e.type === 'end') { if (e.why === 'end_call') noteEndCall(turns, pendingTools); pending = setTimeout(() => finish('agent hung up'), 1500); return; }
      if (e.type !== 'turn') return;
      const turn = { turn: turns.length + 1, role: e.role, text: e.text, interrupted: e.interrupted, at: t, tool_calls: e.role === 'assistant' ? pendingTools : [] };
      if (e.role === 'assistant') {   // the agent's sound this turn (every track; a quiet stretch over 400 ms left out) and its longest quiet stretch
        pendingTools = [];
        turn.audioMs = Math.round((agentAudioBytes / (SAMPLE_RATE * 2)) * 1000);
        turn.pauseMs = Math.round(longestPause);
        agentAudioBytes = 0; longestPause = 0; lastLoudAt = null;
      }
      turns.push(turn);
      log(`${e.role}: ${e.text}`);
      // sm4f (Diwakar: "Are you still there?" came as the spelled name started; the caller answered it with the phone number,
      // queued right behind the name with no pause, and the bench timed a 1171 ms "reply" from the name's end): a caller still
      // saying a line answers a check-in by going on, as a person does
      if (closedBy || !answersTurn(e, preparing || queue.length > 0)) return;
      // S2 (krzysztof's barge-in): the reply the caller cut into is answered by what they said over it, not again
      if (barge && bargeDone && (bargeEndAt === null || now() < bargeEndAt + 500)) { barge = null; return; }
      const got = answerFn ? answerFn(e.text || '', used, e) : null;
      clearTimeout(pending);
      if (got && typeof got.then === 'function') {
        const asked = ++askedTurns;
        preparing = true;
        got.then((next) => { if (asked === askedTurns) preparing = false; if (!closedBy && asked === askedTurns) reply(next); },
          (err) => { error = { message: `caller: ${err?.message || err}` }; finish('error'); });
        return;
      }
      reply(got);
    };
    room.on(RoomEvent.TrackSubscribed, (track, _pub, participant) => {
      if (track.kind !== TrackKind.KIND_AUDIO) return;
      log(`agent ${participant.identity} audio track`);
      // sm7 (Elijah, 14 Oct: his "hello" as the line picked up cut the greeting, and it hummed on nothing): in phone mode the
      // caller says "Hello?" as the line picks up, over the greeting. Not a line the gap is timed from.
      if (PHONE && audio.pickup && !pickedUp) {
        pickedUp = true;
        setTimeout(() => { if (closedBy) return; queue.push(...lineFrames(audio.pickup, chunkMs).map((f) => ({ ...f, lastSoundMs: null }))); log('caller [pickup]'); }, 150);
      }
      const stream = new AudioStreamImpl(track, { sampleRate: SAMPLE_RATE, numChannels: 1 });
      const lane = recorder ? recorder.writer(_pub?.name === 'clips' ? 'clips' : 'voice', _pub?.name || '') : null;
      let trackLoudUntil = 0;   // this track's own sound window (the agent may publish two: its words and the clips)
      let trackLastLoud = -1e9;  // sq3: this track's last loud frame (a new start of sound after 150 ms of quiet)
      (async () => {
        for await (const frame of stream) {
          if (closedBy) break;
          const at = now();
          if (lane) lane.push(new Int16Array(frame.data), benchS(at));   // S2: every frame, quiet ones too
          const bytes = frame.data.length * 2;
          const isLoud = loud(frame.data);
          if (isLoud && _pub?.name !== 'clips') {   // S2: the barge goes in while the agent's own words are going
            voiceLoudUntil = at + 300;
            const b = ctl.barge;
            if (b && !barge && !bargeDone && audio[b.line] && b.afterLineEndAt !== undefined && benchS(at) > b.afterLineEndAt) {
              barge = { line: b.line, dueAt: at + (b.delayMs ?? 900) };
              log(`barge armed: [${b.line}] in ${b.delayMs ?? 900} ms`);
            }
          }
          if (isLoud) {
            if (lastLoudAt !== null && !waitingFirstAudio) longestPause = Math.max(longestPause, at - lastLoudAt);
            lastLoudAt = at + (bytes / (SAMPLE_RATE * 2)) * 1000;
            loudUntil = trackLoudUntil = at + 400;
          } else if (at > trackLoudUntil) continue;
          agentAudioBytes += bytes;
          speechEndsAt = Math.max(speechEndsAt, at) + (bytes / (SAMPLE_RATE * 2)) * 1000;
          const soundAt = at + (firstLoud(frame.data) * 1000) / SAMPLE_RATE;   // the first sound sample's own moment
          if (isLoud && at - trackLastLoud > 150 && curLine && lineStartAt !== null && soundAt >= lineStartAt && (lineEndAt === null || soundAt < lineEndAt)) {
            overTalk.push({ line: curLine, atS: Math.round((soundAt - started) / 10) / 100, msAfterLineStart: Math.round(soundAt - lineStartAt),
              msBeforeLineEnd: lineEndAt === null ? null : Math.round(lineEndAt - soundAt), track: _pub?.name || '', soundAt,
              callerQuietMs: quietAhead(audio[curLine], soundAt - lineStartAt) });   // sm8e
            log(`over the caller [${curLine}] on ${_pub?.name || ''}`);
          }
          if (isLoud) trackLastLoud = at;
          if (waitingFirstAudio && faintAt === null) {   // SUB05: the first faint sound after the caller's last (a soft onset shows here first)
            const fi = firstFaint(frame.data);
            const fAt = fi < 0 ? null : at + (fi * 1000) / SAMPLE_RATE;
            if (fAt !== null && (audioEndAt === null || fAt >= audioEndAt)) faintAt = fAt;
          }
          // SUB05 (run s1): a word said while the caller's line is still going out ("mm-hm" in a pause) is not the reply; the
          // gap counts the first sound at or after the caller's last sound
          if (waitingFirstAudio && isLoud && (audioEndAt === null || soundAt >= audioEndAt)) {
            waitingFirstAudio = false;
            const t = (soundAt - started) / 1000;
            const lastUser = [...turns].reverse().find((x) => x.role === 'user');
            const wall = Date.now() + (soundAt - at);
            const out = [clocks.clip, clocks.agentSpeaking].filter((x) => x !== null);   // the agent's first sound out: the clip or its speech
            const firstOut = out.length ? Math.min(...out) : null;
            const split = { toVadEnd: clocks.vadEnd === null ? null : Math.round(clocks.vadEnd - wallAudioEnd),
              agent: clocks.vadEnd === null || firstOut === null ? null : Math.round(firstOut - clocks.vadEnd),
              down: firstOut === null ? null : Math.round(wall - firstOut),
              clipAfterVadEnd: clocks.vadEnd === null || clocks.clip === null ? null : Math.round(clocks.clip - clocks.vadEnd) };
            firstAudio.push({ afterCallerLine: [...used].pop(), ms: lastUser ? Math.round((t - lastUser.at) * 1000) : null,
              msAfterAudioEnd: audioEndAt === null ? null : Math.round(soundAt - audioEndAt), wall, wallAudioEnd, split, track: _pub?.name || '',
              faintMs: faintAt === null ? null : Math.round(soundAt - faintAt), peak: peakOf(frame.data) });   // SUB05: loud sound this long after the first faint one
            faintAt = null;
            clocks.vadEnd = clocks.agentSpeaking = clocks.clip = null;
          }
        }
      })().catch((err) => { error = { message: `audio: ${err?.message || err}` }; });
    });
    room.on(RoomEvent.Disconnected, () => finish(closedBy || 'agent hung up'));
    room.registerTextStreamHandler('bench', async (reader) => {
      try { onEvent(JSON.parse(await reader.readAll())); } catch (err) { log(`bad bench event: ${err?.message || err}`); }
    });
    (async () => {
      try {
        const token = await tokenFn({ room: roomName, identity });
        await room.connect(url, token, { autoSubscribe: true, dynacast: false });
        const track = LocalAudioTrackImpl.createAudioTrack('caller', source);
        await room.localParticipant.publishTrack(track, { source: TrackSource.SOURCE_MICROPHONE });
      } catch (err) {
        error = { message: `join: ${err?.message || err}` };
        return finish('error');
      }
      const joinedAt = now();
      // The caller's frames go out on a schedule (frame n at streamStart + n * chunkMs). A late tick sends every
      // frame that is due, so the line stays whole; the room's send queue (source.queuedDuration) then holds the
      // backlog, and the last sound's moment on the wire counts that queue.
      const streamStart = now();
      let sentFrames = 0;
      let lastTick = now();
      pump = setInterval(async () => {
        if (closedBy) return;
        if ((now() - started) / 1000 >= maxSeconds) return finish('cap');
        if (!session && now() - joinedAt > joinTimeoutMs) { error = { message: 'the agent never joined' }; return finish('error'); }
        const tickAt = now();
        const late = tickAt - lastTick - chunkMs;
        lastTick = tickAt;
        if (late > chunkMs) { pacing.lateTicks++; pacing.worstLateMs = Math.max(pacing.worstLateMs, Math.round(late)); }
        if (barge && !bargeDone && tickAt >= barge.dueAt) {
          if (voiceLoudUntil > tickAt) { bargeDone = true; ctl.barge.saidAt = Math.round(benchS(tickAt) * 1000) / 1000; log(`caller [${barge.line}] over the agent (barge-in)`); say(barge.line); }
          else barge = null;   // the words ended first: armed again at the next words
        }
        const due = Math.floor((tickAt - streamStart) / chunkMs) + 1;
        while (sentFrames < due && !closedBy) {
          const next = queue.shift();
          let int16 = new Int16Array(samplesPerChunk);
          if (next) { const buf = Buffer.from(next.b64, 'base64'); int16 = new Int16Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length)); }
          const queued = Math.max(0, Number(source.queuedDuration) || 0);   // ms already waiting in the room's send queue
          const wireAt = now() + queued;   // S2: this frame's moment on the wire
          if (next && next.lineStart) {
            lineStartAt = wireAt;
            const sl = [...sayLog].reverse().find((x) => x.id === next.lineStart && x.wireAt === undefined);
            if (sl) sl.wireAt = Math.round(benchS(wireAt) * 1000) / 1000;
          }
          if (next && next.lineId && next.last) {
            const sl = [...sayLog].reverse().find((x) => x.id === next.lineId && x.wireEnd === undefined);
            if (sl) sl.wireEnd = Math.round(benchS(wireAt + chunkMs) * 1000) / 1000;
            if (ctl.barge && next.lineId === ctl.barge.afterLine && ctl.barge.afterLineEndAt === undefined) ctl.barge.afterLineEndAt = benchS(wireAt + chunkMs);
            if (next.lineId === ctl.barge?.line) bargeEndAt = wireAt + chunkMs;
            if (bed?.onLineEnd) bed.onLineEnd(next.lineId, benchS(wireAt + chunkMs));
          }
          if (next && next.lastSoundMs !== null) {
            lineEndAt = now() + queued + next.lastSoundMs;
            const sl = [...sayLog].reverse().find((x) => x.id === next.lineId && x.lastSoundAt === undefined);
            if (sl) sl.lastSoundAt = Math.round(benchS(lineEndAt) * 1000) / 1000;   // S2: the bench's own last-sound moment
            for (const o of overTalk) if (o.line === curLine && o.msBeforeLineEnd === null) o.msBeforeLineEnd = Math.round(lineEndAt - o.soundAt);
            audioEndAt = now() + queued + next.lastSoundMs;
            wallAudioEnd = Date.now() + queued + next.lastSoundMs;
            waitingFirstAudio = true;
            clocks.vadEnd = clocks.agentSpeaking = clocks.clip = null;
          }
          sentFrames++;
          pacing.sent++;
          if (bed) bed.mix(int16, benchS(wireAt));   // S2: the caller's room (speakerphone noise, a laugh)
          if (lineNoise) lineNoise(int16, chunkMs);
          if (callerLane) callerLane.push(int16, benchS(wireAt));   // S2: exactly what the caller sent
          try { await source.captureFrame(new AudioFrameImpl(int16, SAMPLE_RATE, 1, int16.length)); } catch { /* closing */ }
        }
      }, chunkMs);
    })();
  });
}
