// The two test calls: a caller with a leak rings Summit Comfort and books a
// job; a caller who is moving rings Northstar Movers and holds a date.
//
// SPENDS MONEY, so it only runs with `setup.mjs --really --test-calls`, which
// Ethan's money rule allows only once credit overages are off on the Cartesia
// Subscription page (or no card is on the account). `setup.mjs --test-calls`
// alone is a dry run: it prints what each call would send and sends nothing.
//
// How a call is made without a phone. Cartesia's agent WebSocket takes audio
// only (docs.cartesia.ai/line/integrations/websocket-api, read 22 and 23
// September 2026), so each caller line is first spoken with Cartesia's own
// text-to-speech (POST /tts/bytes, raw 16 kHz 16-bit PCM, about 1 credit a
// character: the whole script is under 800 characters) BEFORE the call opens,
// so a failure there costs no agent minute. Then:
//   wss://api.cartesia.ai/v1/agents/websocket/{agent_id}?cartesia_version=2026-08-14
//   header X-API-Key: <the Cartesia key>
//   -> {"type":"session_create","audio":{"input_format":"pcm_16000","output_delivery":"as_available"}}
//   <- session_ready (call_id), then turn_started / turn_output_text_delta /
//      turn_ended (role, text) for both sides, audio_output (not kept).
// Audio goes up every 40 ms, silence between lines (the server hangs up after
// 120 s without an event). After each agent turn ends the caller answers with
// the line that fits what was asked (a few words matched, below), each line at
// most once. A call is cut at MAX_SECONDS whatever happens: two calls of three
// minutes at $0.06 a minute is the $0.36 the spec allows.
//
// Written 23 September 2026, phase S7 of RECEPTIONIST-FINISH-SPEC-2026-09-22.md.

export const MAX_SECONDS = 180;
export const SAMPLE_RATE = 16000;
export const CHUNK_MS = 40;
export const WS_BASE = 'wss://api.cartesia.ai/v1/agents/websocket';
export const TTS_MODEL = 'sonic-3.6';

/**
 * What each caller says, and the words in the agent's last line that call for
 * it. Checked in order; the first unused line whose words match is said.
 * `open` answers the greeting. `bye` is said once nothing else fits.
 */
export const CALLERS = {
  plumbing: {
    goal: 'a leak; the agent books one of its two free times',
    open: "Hi, there's water leaking under my kitchen sink. It's dripping into the cabinet.",
    lines: [
      { id: 'offer', when: /\b(eight|ten|one|three|8|10|1|3)\b.*\b(or|works?|suit|okay|good)\b|\bwhich\b.*\b(works?|suits?)\b/i, say: 'The first one works for me.' },
      { id: 'where', when: /\b(address|where|street|located|town)\b/i, say: "It's 14 Maple Street, in Fairview." },
      { id: 'how-bad', when: /\b(how (bad|much|fast)|flood|steady|shut|valve|stop|spray|drip)/i, say: "It's a steady drip, not flooding. I've put a bucket under it." },
      { id: 'when', when: /\b(when|today|soon|urgent)\b/i, say: 'Today or tomorrow would be great.' },
      { id: 'name', when: /\bname\b/i, say: "It's Dana." },
      { id: 'number', when: /\b(number|phone|reach|text)\b/i, say: 'Three one two, five five five, zero one four two.' },
    ],
    bye: "No, that's everything. Thanks, bye.",
  },
  moving: {
    goal: 'a two-bedroom move; the agent holds a date',
    open: "I'm moving from a two-bedroom apartment in Oak Park to a house in Evanston.",
    lines: [
      { id: 'offer', when: /\b(saturday|monday|tuesday|wednesday|thursday|friday)\b.*\?/i, say: 'Yes, please hold that Saturday for me.' },
      { id: 'when', when: /\b(when|date|day|week)\b/i, say: 'In the next couple of weeks. A Saturday would be best.' },
      { id: 'size', when: /\b(size|bedrooms?|how (much|big|many)|rooms?)\b/i, say: 'Two bedrooms, just the usual furniture.' },
      { id: 'access', when: /\b(stairs?|lift|elevator|floor|steps|access)\b/i, say: 'Second floor walk-up, no lift. The new place has three steps at the door.' },
      { id: 'special', when: /\b(heavy|piano|special|safe|anything (else|big))\b/i, say: 'Just a big fridge. Nothing else heavy.' },
      { id: 'name', when: /\bname\b/i, say: "It's Sam." },
      { id: 'number', when: /\b(number|phone|reach|call you)\b/i, say: 'Three one two, five five five, zero one four two.' },
    ],
    bye: "No, that's everything. Thanks, bye.",
  },
};

/** Every line a caller might say, in the order the script lists them. */
export function callerLines(trade) {
  const c = CALLERS[trade];
  return [{ id: 'open', say: c.open }, ...c.lines.map(({ id, say }) => ({ id, say })), { id: 'bye', say: c.bye }];
}

/** The caller's answer to the agent's last line, or null to hang up. */
export function answer(trade, agentText, used) {
  const c = CALLERS[trade];
  if (!used.has('open')) return 'open';
  if (used.has('bye')) return null;
  const fit = c.lines.find((l) => !used.has(l.id) && l.when.test(agentText));
  if (fit) return fit.id;
  // Nothing fits: a goodbye from the agent, or a question the script lacks.
  if (/\b(bye|goodbye|take care|have a (good|great|nice)|anything else)\b/i.test(agentText) || !/\?/.test(agentText)) return 'bye';
  const next = c.lines.find((l) => !used.has(l.id) && l.id !== 'offer');
  return next ? next.id : 'bye';
}

/** POST /tts/bytes body for one caller line. */
export function ttsBody(text, voiceId) {
  return {
    model_id: TTS_MODEL,
    transcript: text,
    voice: { mode: 'id', id: voiceId },
    output_format: { container: 'raw', encoding: 'pcm_s16le', sample_rate: SAMPLE_RATE },
    language: 'en',
  };
}

/** Base64 chunks of CHUNK_MS each; the last one padded with silence. */
export function chunks(pcm, ms = CHUNK_MS) {
  const size = (SAMPLE_RATE * 2 * ms) / 1000;
  const out = [];
  for (let i = 0; i < pcm.length; i += size) {
    const part = Buffer.alloc(size);
    Buffer.from(pcm).copy(part, 0, i, Math.min(i + size, pcm.length));
    out.push(part.toString('base64'));
  }
  return out;
}

export const SILENCE = Buffer.alloc((SAMPLE_RATE * 2 * CHUNK_MS) / 1000).toString('base64');

/** What `--test-calls` without `--really` prints: every request, nothing sent. */
export function testCallPlanText({ trades, voice, agents }) {
  const out = [];
  out.push('TEST CALLS, DRY RUN. Nothing is sent. `--really --test-calls` would do this, for each trade in turn:');
  out.push(`  (cap: ${MAX_SECONDS} s a call; at $0.06 a minute that is at most $${(0.06 * MAX_SECONDS / 60).toFixed(2)} a call, $${(0.06 * MAX_SECONDS / 60 * trades.length).toFixed(2)} for ${trades.length})`);
  for (const t of trades) {
    const lines = callerLines(t);
    const chars = lines.reduce((n, l) => n + l.say.length, 0);
    out.push('');
    out.push(`${t}: ${CALLERS[t].goal}. Agent ${agents?.[t] || '<id found by name at run time>'}.`);
    out.push(`  1. ${lines.length} x POST /tts/bytes (caller lines, ${chars} characters, about ${chars} credits), each:`);
    out.push(`     ${JSON.stringify(ttsBody(lines[0].say, voice))}`);
    out.push(`  2. open ${WS_BASE}/${agents?.[t] || '<agent id>'}?cartesia_version=2026-08-14 with header X-API-Key`);
    out.push('     send {"type":"session_create","audio":{"input_format":"pcm_16000","output_delivery":"as_available"}}');
    out.push(`     then {"type":"audio_input","audio":"<${CHUNK_MS} ms of base64 PCM>"} every ${CHUNK_MS} ms until the agent hangs up or ${MAX_SECONDS} s`);
    out.push('  3. GET /agents/calls/{call_id} (the transcript and tool calls Cartesia kept)');
    out.push(`  4. GET <site>/feed.ics (whether the booking landed; the Worker there must carry /api/demo/book)`);
    out.push('  The caller\'s lines, said when the agent\'s last words fit:');
    for (const l of lines) out.push(`     [${l.id}] ${l.say}`);
  }
  out.push('');
  out.push('Saved to test/out/line/test-call-<trade>-<time>.json: call id, times, every turn with its text and when it ended, the agent\'s first reply time per turn, and Cartesia\'s own record of the call.');
  return out.join('\n');
}

/**
 * One call over the agent WebSocket. `openSocket(url)` returns a WebSocket;
 * `audio` maps a caller line id to its PCM; `wait` and `now` are injectable so
 * the loop is tested offline with a fake agent.
 */
export function runCall({ trade, agentId, openSocket, audio, maxSeconds = MAX_SECONDS, chunkMs = CHUNK_MS, now = () => Date.now(), replyDelayMs = 600, log = () => {}, answerFn = null, waitMs = 12_000, afterSpeechMs = 700, byeMs = 20_000 }) {
  // answerFn(agentText, used) (L4b, 30 Sep 2026): a line's own caller script.
  // It may also answer 'wait' (the agent said something that needs no answer,
  // like "Let me check that date"): the caller stays quiet, and only if the
  // agent says nothing more for waitMs says "hello" (its line id), then bye.
  // The caller never talks over the robot: each answer waits until the robot's
  // audio would have finished playing (bytes / 32000 s from when it came) plus
  // afterSpeechMs.
  // H1 (7 Oct 2026, the bench): answerFn may return a Promise (the caller's
  // words come from a model and are spoken by TTS while the call runs; silence
  // goes up meanwhile); firstAudioMs also carries msAfterAudioEnd (the last
  // chunk of the caller's audio sent to the first agent audio back); each
  // assistant turn carries audioMs (the agent audio that came since the last
  // assistant turn ended, at 16 kHz 16-bit).
  return new Promise((resolve) => {
    const started = now();
    const turns = [];
    const used = new Set();
    const queue = [];
    const firstAudio = [];
    let session = null;
    let waitingFirstAudio = false;
    let closedBy = null;
    let pending = null;
    let error = null;
    let speechEndsAt = 0;            // when the robot's audio so far would finish playing
    let audioEndAt = null;           // when the last chunk of the caller's line went up
    let agentAudioBytes = 0;         // agent audio since the last assistant turn ended
    const sayLog = [];               // [{id, at}] every caller line, when it was queued
    const url = `${WS_BASE}/${agentId}?cartesia_version=2026-08-14`;
    const ws = openSocket(url);

    const finish = (why) => {
      if (closedBy) return;
      closedBy = why;
      clearInterval(pump);
      clearTimeout(pending);
      try { ws.close(1000); } catch { /* already closed */ }
      resolve({ trade, agentId, callId: session?.call_id || null, agentVersionId: session?.agent_version_id || null,
        seconds: (now() - started) / 1000, closedBy: why, error, turns, firstAudioMs: firstAudio, said: [...used], sayLog });
    };

    const say = (id) => {
      // H3 (Astra H-human 5): a line with no audio made (the bench makes its goodbye only when its caller
      // says one) ends the call here, its result kept, instead of throwing inside the timer.
      if (!audio[id]) { log(`caller [${id}] has no audio: the caller hangs up`); return finish('caller hung up'); }
      used.add(id);
      // After the caller's goodbye the call ends within byeMs, whatever the robot does.
      if (id === 'bye' && answerFn) setTimeout(() => finish('caller hung up'), byeMs);
      sayLog.push({ id, at: (now() - started) / 1000 });
      queue.push(...chunks(audio[id]));
      log(`caller [${id}]`);
    };

    const pump = setInterval(() => {
      if (!session) return;
      if ((now() - started) / 1000 >= maxSeconds) return finish('cap');
      const next = queue.shift();
      if (next && !queue.length) { waitingFirstAudio = true; audioEndAt = now(); }
      try { ws.send(JSON.stringify({ type: 'audio_input', audio: next || SILENCE })); } catch { /* closing */ }
    }, chunkMs);

    ws.onopen = () => ws.send(JSON.stringify({ type: 'session_create', audio: { input_format: 'pcm_16000', output_delivery: 'as_available' } }));
    ws.onmessage = (m) => {
      let e;
      try { e = JSON.parse(typeof m.data === 'string' ? m.data : Buffer.from(m.data).toString()); } catch { return; }
      const t = (now() - started) / 1000;
      if (e.type === 'session_ready') { session = e; log(`session ${e.call_id}`); return; }
      if (e.type === 'audio_output' && typeof e.audio === 'string') {
        const at = now();
        const bytes = Buffer.from(e.audio, 'base64').length;
        agentAudioBytes += bytes;
        speechEndsAt = Math.max(speechEndsAt, at) + (bytes / (SAMPLE_RATE * 2)) * 1000;
      }
      if (e.type === 'audio_output' && waitingFirstAudio) {
        waitingFirstAudio = false;
        const lastUser = [...turns].reverse().find((x) => x.role === 'user');
        firstAudio.push({ afterCallerLine: [...used].pop(), ms: lastUser ? Math.round((t - lastUser.at) * 1000) : null,
          msAfterAudioEnd: audioEndAt === null ? null : Math.round(now() - audioEndAt) });
        return;
      }
      if (e.type === 'error') { error = { message: e.message || e.error || null, fatal: e.fatal }; if (e.fatal) finish('error'); return; }
      if (e.type !== 'turn_ended') return;
      const turn = { turn: e.turn, role: e.role, text: e.text, interrupted: e.interrupted, at: t, tool_calls: e.tool_calls || [] };
      if (e.role === 'assistant') { turn.audioMs = Math.round((agentAudioBytes / (SAMPLE_RATE * 2)) * 1000); agentAudioBytes = 0; }
      turns.push(turn);
      log(`${e.role}: ${e.text}`);
      if (e.role !== 'assistant') return;
      const got = answerFn ? answerFn(e.text || '', used, e) : answer(trade, e.text || '', used);
      clearTimeout(pending);
      if (got && typeof got.then === 'function') {
        const agentTurns = () => turns.filter((x) => x.role === 'assistant').length;
        const asked = agentTurns();   // a newer agent turn makes this answer stale; that turn gets its own
        got.then((next) => { if (!closedBy && agentTurns() === asked) reply(next); },
          (err) => { error = { message: `caller: ${err?.message || err}` }; finish('error'); });
        return;
      }
      reply(got);
    };
    const reply = (next) => {
      clearTimeout(pending);
      if (next === null) { pending = setTimeout(() => finish('caller hung up'), 1500); return; }
      const delay = () => Math.max(replyDelayMs, speechEndsAt - now() + afterSpeechMs);
      if (next === 'wait') {
        const nudge = audio.hello && !used.has('hello') ? 'hello' : used.has('bye') || !audio.bye ? null : 'bye';
        pending = setTimeout(() => (nudge ? say(nudge) : finish('caller hung up')), Math.max(waitMs, delay()));
        return;
      }
      pending = setTimeout(() => say(next), delay());
    };
    ws.onerror = (err) => { error = { message: String(err?.message || err?.type || 'socket error') }; };
    ws.onclose = (c) => finish(closedBy || (c?.code === 1000 ? 'agent hung up' : `closed ${c?.code ?? ''}`.trim()));
  });
}
