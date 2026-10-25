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
import { readFileSync } from 'node:fs';
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
  if (process.env.BENCH_AGENT_NAME) at.roomConfig = new RoomConfiguration({ agents: [new RoomAgentDispatch({ agentName: process.env.BENCH_AGENT_NAME })] });
  return at.toJwt();
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
  replyDelayMs = 600, log = () => {}, answerFn = null, waitMs = 12_000, afterSpeechMs = 700, byeMs = 20_000, joinTimeoutMs = 20_000, identity = 'caller' }) {
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
    const room = new Room();
    const samplesPerChunk = (SAMPLE_RATE * chunkMs) / 1000;
    const source = new AudioSource(SAMPLE_RATE, 1);
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
        overTalk: overTalk.map(({ soundAt, ...o }) => o) });
    };
    const say = (id) => {
      if (!audio[id]) { log(`caller [${id}] has no audio: the caller hangs up`); return finish('caller hung up'); }
      used.add(id);
      if (id === 'bye' && answerFn) setTimeout(() => finish('caller hung up'), byeMs);
      sayLog.push({ id, at: (now() - started) / 1000, wall: Date.now() });
      const frames = lineFrames(audio[id], chunkMs);
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
      const stream = new AudioStream(track, { sampleRate: SAMPLE_RATE, numChannels: 1 });
      let trackLoudUntil = 0;   // this track's own sound window (the agent may publish two: its words and the clips)
      let trackLastLoud = -1e9;  // sq3: this track's last loud frame (a new start of sound after 150 ms of quiet)
      (async () => {
        for await (const frame of stream) {
          if (closedBy) break;
          const at = now();
          const bytes = frame.data.length * 2;
          const isLoud = loud(frame.data);
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
        const token = await callerToken({ room: roomName, identity });
        await room.connect(url, token, { autoSubscribe: true, dynacast: false });
        const track = LocalAudioTrack.createAudioTrack('caller', source);
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
        const due = Math.floor((tickAt - streamStart) / chunkMs) + 1;
        while (sentFrames < due && !closedBy) {
          const next = queue.shift();
          let int16 = new Int16Array(samplesPerChunk);
          if (next) { const buf = Buffer.from(next.b64, 'base64'); int16 = new Int16Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length)); }
          const queued = Math.max(0, Number(source.queuedDuration) || 0);   // ms already waiting in the room's send queue
          if (next && next.lineStart) lineStartAt = now() + queued;
          if (next && next.lastSoundMs !== null) {
            lineEndAt = now() + queued + next.lastSoundMs;
            for (const o of overTalk) if (o.line === curLine && o.msBeforeLineEnd === null) o.msBeforeLineEnd = Math.round(lineEndAt - o.soundAt);
            audioEndAt = now() + queued + next.lastSoundMs;
            wallAudioEnd = Date.now() + queued + next.lastSoundMs;
            waitingFirstAudio = true;
            clocks.vadEnd = clocks.agentSpeaking = clocks.clip = null;
          }
          sentFrames++;
          pacing.sent++;
          if (lineNoise) lineNoise(int16, chunkMs);
          try { await source.captureFrame(new AudioFrame(int16, SAMPLE_RATE, 1, int16.length)); } catch { /* closing */ }
        }
      }, chunkMs);
    })();
  });
}
