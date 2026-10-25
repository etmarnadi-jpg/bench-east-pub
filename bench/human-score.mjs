#!/usr/bin/env node
// The human score (H1, 7 Oct 2026; SPEC receptionist-human H1, H8).
//
//   node bench/human-score.mjs <call.json>              a Cartesia call record, or a bench record (bench/run.mjs)
//   node bench/human-score.mjs <callId> [--line harbor] one read-only GET of the call on the line's own account
//   add --json for the numbers as JSON
//
// One line a part: our number, the human mark beside it (bench/marks.json, from
// bench/HUMAN-BASELINE.md), and the part's score; then one total 0-100 (100 =
// at the human mark). Plain code, no model judging. A part it cannot measure
// (no words in the record, no truth for "heard right") is left out of the total
// and says so.
//
// Read-only: nothing is sent anywhere except, with a call id, one GET of
// /agents/calls/<id> (tools/call-speed.mjs fetchCall, the key by lib/accounts.mjs).
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { callTurns, fetchCall } from '../tools/call-speed.mjs';
import { readLine, promptFacts } from '../lib/lineagent.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const MARKS = JSON.parse(readFileSync(join(HERE, 'marks.json'), 'utf8'));
/** HW2 (9 Oct 2026): Ethan's goal for the wait, tighter than the marks' close bands (1.0 and 2.0 s); a score can be close to
 * human and still miss it, so it is checked and printed on its own (Astra HW2 finding 5). */
export const GOAL = { medianS: 0.5, slowestS: 1.0 };
export const goalCheck = (m) => {
  const medianOk = Number.isFinite(m?.gapMedian) && m.gapMedian <= GOAL.medianS;
  const slowestOk = Number.isFinite(m?.gapSlowest) && m.gapSlowest <= GOAL.slowestS;
  return { median: m?.gapMedian ?? null, slowest: m?.gapSlowest ?? null, medianOk, slowestOk, ok: medianOk && slowestOk };
};

// ------------------------------------------------------------------ words
export const wordsOf = (t) => String(t || '').match(/[A-Za-z0-9'’]+/g) || [];
const norm = (t) => wordsOf(t).map((w) => w.toLowerCase().replace(/’/g, "'")).join(' ');
export const sentencesOf = (t) => String(t || '').split(/[.?!]+/).map((s) => s.trim()).filter(Boolean);
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// The same reaction words as bench/baseline-from-dataset.py REACT_START (the human number is counted with them).
export const REACT_START = /^(yeah|yes|yep|oh|okay|ok|right|sure|wow|mm|mhm|uh-huh|ah|nice|cool|great|i see|got it|gotcha|that's (great|good|nice|cool|awesome|funny|interesting|true|right|fair|rough|tough|too bad)|oh no|no way|really|totally|exactly|absolutely|definitely|interesting|awesome|ha|haha|fair enough|sorry|i'm sorry|thanks|thank you|perfect|no problem|of course|alright|all right|good|lovely)\b/i;

const SAID_DIGIT = { zero: '0', oh: '0', o: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9' };
/** Every digit a piece of speech says, in order ("four two five", "425-443", "double five" -> digits). */
export function spokenDigits(text) {
  const t = String(text || '').toLowerCase()
    .replace(/\b(double|triple)[\s-]+(zero|oh|one|two|three|four|five|six|seven|eight|nine|\d)\b/g, (m, n, d) => (SAID_DIGIT[d] ?? d).repeat(n === 'double' ? 2 : 3));
  return (t.match(/\b(zero|oh|one|two|three|four|five|six|seven|eight|nine)\b|\d/g) || []).map((w) => SAID_DIGIT[w] ?? w).join('');
}

const YES = /\b(yes|yeah|yep|yup|sure|please|go ahead|sounds good|that works|works for me|okay|ok|perfect|do it|book it|pencil (it|that) in|that's fine|correct|absolutely|definitely)\b/i;
const NO = /^\s*(no|nope|nah)\b(?!\s*(problem|worries))|\b(don't|do not|please don't|not yet|rather not|never|wait)\b/i;
/** A yes to the offered date: an agreeing word with no refusal in the reply ("No, please don't book it" is not a yes; Astra HW2 finding 8). */
export const isYes = (text) => YES.test(String(text || '')) && !NO.test(String(text || ''));
const PRICE = /\$\s*\d|\b(dollars?|bucks)\b|\b\d+\s*(an|per)\s*hour\b/i;

// ------------------------------------------------------------------ the record, in one shape
const toolsOf = (e) => (Array.isArray(e?.tool_calls) ? e.tool_calls : []).map((c) => ({
  name: String(c?.name || c?.function?.name || ''),
  args: typeof c?.arguments === 'string' ? safeJson(c.arguments) : (c?.arguments || c?.args || {}),
  result: typeof c?.result === 'string' ? c.result : JSON.stringify(c?.result ?? ''),
  at: typeof c?.at === 'number' ? c.at : undefined,   // when the tool started (SUB05)
}));
function safeJson(s) { try { return JSON.parse(s); } catch { return {}; } }

/** Turns from a Cartesia transcript: one caller turn per run of user entries, one agent turn per run of assistant entries. */
export function cartesiaTurns(transcript) {
  const out = [];
  for (const e of Array.isArray(transcript) ? transcript : []) {
    if (e?.role !== 'user' && e?.role !== 'assistant') continue;
    const role = e.role === 'user' ? 'caller' : 'agent';
    const last = out.at(-1);
    const piece = { text: String(e.text ?? ''), start: Number(e.start_timestamp), end: Number(e.end_timestamp), interrupted: Boolean(e.was_interrupted), tools: toolsOf(e), hasText: typeof e.text === 'string' };
    if (last && last.role === role) {
      last.text = `${last.text} ${piece.text}`.trim();
      last.end = piece.end;
      last.interrupted = last.interrupted || piece.interrupted;
      last.tools.push(...piece.tools);
      last.pieces.push(piece);
    } else out.push({ role, ...piece, pieces: [piece] });
  }
  return out;
}

/** One shape for a Cartesia call record or a bench record. */
export function readRecord(rec) {
  if (!rec || typeof rec !== 'object') throw new Error('not a call record');
  if (rec.kind === 'bench') {
    const cart = rec.cartesia && Array.isArray(rec.cartesia.transcript) ? rec.cartesia : null;
    const own = (rec.turns || []).map((t) => ({
      role: t.role === 'user' || t.role === 'caller' ? 'caller' : 'agent', text: String(t.text || ''), start: NaN, end: NaN,
      interrupted: Boolean(t.interrupted), tools: toolsOf(t), hasText: true, audioMs: Number(t.audioMs) || 0,
    }));
    // Cartesia's record has the tool calls with their answers; the bench's own turns have the agent's audio lengths.
    const turns = cart ? cartesiaTurns(cart.transcript) : own;
    if (cart) {
      const a = turns.filter((t) => t.role === 'agent');
      const b = own.filter((t) => t.role === 'agent');
      // H2: the bench may miss the last agent turn (the call closes as it ends): match from the start.
      if (b.length && b.length <= a.length && b.every((t, i) => !t.text || !a[i].text || norm(t.text) === norm(a[i].text))) b.forEach((t, i) => { a[i].audioMs = t.audioMs; });
    }
    return { id: rec.callId || cart?.id || '', kind: 'bench', agentName: cart?.agent_name || rec.agentName || '', turns, timed: cart ? callTurns(cart) : [], benchGapsMs: (rec.gaps || []).map((g) => g.ms).filter(Number.isFinite), truth: rec.truth || null };
  }
  if (!Array.isArray(rec.transcript)) throw new Error('a call record has a "transcript" list (Cartesia) or "kind": "bench"');
  return { id: rec.id || '', kind: 'cartesia', agentName: rec.agent_name || '', turns: cartesiaTurns(rec.transcript), timed: callTurns(rec), benchGapsMs: [], truth: rec.truth || null };
}

// ------------------------------------------------------------------ stock lines
const NOT_STOCK = /^(Monday, October 5th|As soon as you can|that.s all|wants \[\[owner\]\] himself)$/;

// H2 (7 Oct 2026): the lines the H1 prompt quoted (base/prompt.md at 7c0354e), kept here so a prompt
// that stops quoting them does not make the stock-line count look better than it is.
export const H1_PROMPT_LINES = ['A couch, sure.', 'Best number for you?', "What's your name?", 'So, what day suits you?',
  '[[owner]] will call you to confirm everything.', 'Thanks for calling, <their name>. Bye now.'];

/** The fixed lines a line's receptionist is given: its line.json lines, the prompt's quoted lines (now and in H1), the site's tool answers. */
export function stockPhrases(lineId) {
  const out = new Set(["Is that right?", 'Anything else?', 'Want me to pencil that in?', 'is pencilled in for you', 'is too soon to book', 'That date is not free', "Okay, I won't pencil in", 'Are you still there?']);
  let line = null; let template = '';
  try { ({ line, template } = readLine(lineId)); } catch { /* no line: only the shared phrases */ }
  if (line) {
    const f = promptFacts(line);
    for (const k of ['callbackNow', 'urgentLine', 'urgentJobLine', 'coverLine', 'outsideLine', 'dontKnowLine', 'confirm', 'quote', 'callbackLine', 'hours']) if (f[k]) for (const s of sentencesOf(f[k])) out.add(s);
    // Quoted lines on one line of the prompt; not its format examples or the caller's words.
    for (const q of [...[...String(template).matchAll(/"([^"\n]*)"/g)].map((m) => m[1]), ...H1_PROMPT_LINES]) {
      if (q.length < 6 || /\[\[(?!owner|business)/.test(q) || NOT_STOCK.test(q)) continue;
      out.add(q.replace(/\[\[owner\]\]/g, line.owner || line.business).replace(/\[\[business\]\]/g, line.business));
    }
  }
  return [...out].map((p) => ({ text: p, words: norm(p.replace(/<[^>]*>/g, ' ')).split(' ').filter(Boolean), wild: /<[^>]*>/.test(p), parts: p.split(/<[^>]*>/).map(norm).filter(Boolean) }))
    .filter((p) => p.words.length >= 2);
}

const has = (hay, needle) => ` ${hay} `.includes(` ${needle} `);
function saysPhrase(text, p) {
  const t = norm(text);
  if (!p.wild) return has(t, p.words.join(' '));
  let at = 0;
  for (const part of p.parts) { const i = ` ${t} `.indexOf(` ${part} `, at); if (i < 0) return false; at = i + part.length; }
  return true;
}

// ------------------------------------------------------------------ the parts
const lineForAgent = (name) => {
  for (const id of ['harbor', 'luterson']) { try { if (readLine(id).line.agent === name) return id; } catch { /* not here */ } }
  return null;
};

function nameTokens(truthName) { return wordsOf(truthName).map((w) => w.toLowerCase()); }
const close = (a, b) => a === b;

/** Every part's raw number (null = cannot be measured from this record). */
export function measure(r, { lineId = null } = {}) {
  const agentTurns = r.turns.filter((t) => t.role === 'agent');
  const firstCaller = r.turns.findIndex((t) => t.role === 'caller');
  const greeting = firstCaller > 0 ? r.turns.slice(0, firstCaller).filter((t) => t.role === 'agent') : [];
  const answers = agentTurns.filter((t) => !greeting.includes(t));
  const withText = r.turns.some((t) => t.text && t.text.trim());
  const caller = r.turns.filter((t) => t.role === 'caller');
  const m = { notes: [] };

  // 1. Gap to first word. A Cartesia record: its agent_turn_ms (caller's last word as Cartesia judged it to
  // the receptionist's first; no-tool median, slowest of all). A bench record (H2, 7 Oct 2026): the bench's
  // own gap, every turn (the end of the caller's audio to the first agent audio back: what the caller feels,
  // Cartesia's wait for the end of the turn included), with agent_turn_ms kept beside it.
  const plain = r.timed.filter((t) => t.noTool).map((t) => t.ms / 1000);
  const all = r.timed.map((t) => t.ms / 1000);
  m.agentTurn = all.length ? { median: plain.length ? median(plain) : median(all), slowest: Math.max(...all) } : null;
  m.benchGap = r.benchGapsMs.length ? { median: median(r.benchGapsMs) / 1000, slowest: Math.max(...r.benchGapsMs) / 1000 } : null;
  if (r.kind === 'bench' && m.benchGap) {
    m.gapMedian = m.benchGap.median; m.gapSlowest = m.benchGap.slowest;
    m.notes.push('gap: the bench\'s own (end of the caller\'s audio to the first agent audio), every turn');
  } else {
    m.gapMedian = m.agentTurn ? m.agentTurn.median : null;
    m.gapSlowest = m.agentTurn ? m.agentTurn.slowest : null;
    if (r.kind === 'bench') m.notes.push('gap: Cartesia\'s agent_turn_ms (this bench record has no gap of its own)');
  }
  m.allTurnsMedian = all.length ? median(all) : null;
  if (!withText) { for (const k of ['wordsPerTurn', 'speechRate', 'repeats', 'stockLines', 'reacts', 'usesName', 'oneQuestion', 'heardRight', 'taskRight']) m[k] = null; m.notes.push('no words in this record: only the gap parts'); return m; }

  // 2. Words per turn (the greeting left out: it is fixed).
  m.wordsPerTurn = answers.length ? median(answers.map((t) => wordsOf(t.text).length)) : null;
  // 3. Speech rate: turns of 3+ words, not cut off, with their own times.
  // Only from the agent's own audio length (a bench record's audioMs): in Cartesia's record an
  // assistant entry ends when the caller next speaks (Elijah's call: every end equals the next start).
  const rates = answers.filter((t) => !t.interrupted && wordsOf(t.text).length >= 3 && t.audioMs > 0).map((t) => wordsOf(t.text).length / (t.audioMs / 60000));
  m.speechRate = rates.length ? median(rates) : null;
  if (!rates.length) m.notes.push('speech rate needs the agent\'s audio lengths (a bench record): left out');
  // 4. Repeats: a sentence of 6+ words said again by the receptionist (greeting included).
  const seen = new Map();
  let repeats = 0;
  const repeated = [];
  for (const t of agentTurns) for (const s of sentencesOf(t.text)) {
    const k = norm(s);
    if (k.split(' ').length < 6) continue;
    if (seen.has(k)) { repeats++; repeated.push(s); } else seen.set(k, true);
  }
  m.repeats = repeats;
  m.repeated = repeated;
  // 5. Stock lines: a fixed line of 4+ words said (each turn once), and each re-use of a shorter one.
  const phrases = stockPhrases(lineId || lineForAgent(r.agentName) || 'harbor');
  let stock = 0;
  const used = new Map();
  const stockSaid = [];
  for (const t of answers) {
    let long = false;
    for (const p of phrases) {
      if (!saysPhrase(t.text, p)) continue;
      if (p.words.length >= 4) long = true;
      else { const n = (used.get(p.text) || 0) + 1; used.set(p.text, n); if (n > 1) { stock++; stockSaid.push(p.text); } }
    }
    if (long) { stock++; stockSaid.push(t.text); }
  }
  m.stockLines = stock;
  m.stockSaid = stockSaid;
  // 6. Reacts first: a turn after the caller spoke that starts with a reaction word or the caller's name.
  const truthName = r.truth?.name || '';
  const cardName = agentTurns.flatMap((t) => t.tools).find((c) => /card|hold/.test(c.name) && c.args?.name && !/not given/i.test(c.args.name))?.args?.name || '';
  const name = truthName || cardName;
  const first = nameTokens(name)[0] || '';
  let after = 0; let react = 0;
  r.turns.forEach((t, i) => {
    if (t.role !== 'agent' || i === 0 || r.turns[i - 1].role !== 'caller') return;
    after++;
    const start = norm(t.text).split(' ').slice(0, 3);
    // H2: Cartesia writes a curly apostrophe ("I’m sorry"); the reaction words are written with a straight one.
    if (REACT_START.test(String(t.text).trim().replace(/[\u2018\u2019]/g, "'")) || (first && start.includes(first))) react++;
  });
  m.reacts = after ? react / after : null;
  // 7. Uses the caller's name after they said it.
  const saidAt = first ? r.turns.findIndex((t) => t.role === 'caller' && norm(t.text).split(' ').includes(first)) : -1;
  m.usesName = saidAt < 0 ? null : (r.turns.slice(saidAt + 1).some((t) => t.role === 'agent' && norm(t.text).split(' ').includes(first)) ? 1 : 0);
  if (!first) m.notes.push('caller\'s name not known: "uses name" left out');
  // 8. One question at a time.
  const qTurns = answers.filter((t) => /\?/.test(t.text));
  m.oneQuestion = qTurns.length ? qTurns.filter((t) => (t.text.match(/\?/g) || []).length >= 2).length / qTurns.length : 0;

  // 9 and 10. Rules, heard right, task right.
  const callerDigits = caller.map((t) => spokenDigits(t.text)).join('|');
  const broken = [];
  for (const t of answers) if (PRICE.test(t.text)) broken.push(`price: "${t.text}"`);
  const usedYes = new Set();   // ur9: each pencil-in question's yes is used for one hold
  r.turns.forEach((t, i) => {
    for (const c of t.role === 'agent' ? t.tools : []) {
      const isHold = /hold/.test(c.name) && c.args?.action !== 'release';
      if (isHold) {
        // the caller's line before the hold started (SUB05: a line that came in while the hold ran is not the one it answered)
        const before = r.turns.slice(0, i).reverse().find((x) => x.role === 'caller' && (c.at === undefined || x.at === undefined || x.at <= c.at));
        // SUB05 s5: the hearing splits one caller line in two ("Sure thing." / "ahead and pencil that in"): the yes is read
        // across every caller line since the receptionist last spoke
        const bi = before ? r.turns.indexOf(before) : -1;
        const run = [];
        for (let k = bi; k >= 0 && r.turns[k].role === 'caller'; k--) run.unshift(r.turns[k].text);
        // cf3 (sp1 Diwakar: "Want me to pencil that in?" "Sure. That works." then the spelling asked and given, then the hold):
        // a yes to the latest pencil-in question stands until the caller says no
        let earlier = false;
        const qi = r.turns.slice(0, bi < 0 ? 0 : bi).map((x, k) => [x, k]).reverse().find(([x]) => x.role === 'agent' && (String(x.text).match(/[^.?!]*\?/g) || []).some((q) => /pencil/i.test(q) && !/spell|name|number/i.test(q)));
        // cf7 (sp3 Diwakar: "Before I pencil that in, could you spell your full name for me?" is the spelling ask, not the pencil-in question)
        if (qi) {
          const ans = [];
          for (let k = qi[1] + 1; k < r.turns.length && r.turns[k].role === 'caller'; k++) ans.push(r.turns[k].text);
          const since = r.turns.slice(qi[1] + 1, bi + 1).filter((x) => x.role === 'caller').map((x) => x.text);
          // ur9 (review of PR 2): a no anywhere in a line that is not a spelling takes it back; the yes covers one hold only, and
          // only of the date last checked before that question
          const spelt = (x) => /(?:\b[A-Za-z]\b[\s.,-]*){3,}/.test(x);
          const takenBack = since.some((x) => !spelt(x) && /\b(no|nope|nah|not yet|don'?t|wait|actually)\b/i.test(x));
          const checked = r.turns.slice(0, qi[1] + 1).flatMap((x) => (x.role === 'agent' ? x.tools : [])).filter((x) => /check/.test(x.name) && x.args?.date).at(-1);
          const sameDate = !!checked && checked.args.date === c.args?.date;
          earlier = isYes(ans.join(' ')) && !takenBack && sameDate && !usedYes.has(qi[1]);
          if (earlier) usedYes.add(qi[1]);
        }
        if (!before || !(isYes(run.join(' ')) || earlier)) broken.push(`hold without a yes: ${c.args?.date || ''} after "${run.join(' ') || ''}"`);
      }
      for (const k of ['callback']) {
        const d = String(c.args?.[k] ?? '').replace(/\D/g, '');
        if (d.length >= 7 && !callerDigits.replace(/\|/g, '').includes(d) && !callerDigits.split('|').some((x) => x.includes(d.slice(-7)))) broken.push(`made-up number: ${c.name} ${k} ${d}`);
      }
    }
  });
  // H2 (7 Oct 2026, the Krzysztof bench call): a turn that asks something and hangs up in the same breath
  // ("Anything else?" with end_call) leaves the caller talking to nobody.
  for (const t of answers) if (t.tools.some((c) => c.name === 'end_call') && /\?/.test(t.text)) broken.push(`hung up on a question: "${t.text}"`);
  m.broken = broken;
  // H3 (Astra H-human 7): a hold counts only when the site's answer says so (ok true, and the date it
  // held); the words "pencilled in" are also in a refusal ("so nothing is pencilled in").
  const heldBy = (c) => { const r = safeJson(c.result); return r && r.ok === true && typeof r.held === 'string' ? r.held : ''; };
  const holds = agentTurns.flatMap((t) => t.tools).filter((c) => /hold/.test(c.name) && c.args?.action !== 'release' && heldBy(c));
  const truth = r.truth;
  if (truth) {
    const items = [];
    const wrong = { name: 0 };
    if (truth.name) {
      const want = nameTokens(truth.name);
      const said = new Set();
      const stop = new Set(stopWords(lineId || lineForAgent(r.agentName)));
      for (const t of agentTurns) {
        const toks = String(t.text).split(/\s+/);
        toks.forEach((w, i) => {
          // H2: Cartesia writes a curly apostrophe; "I’m", "I’ve" are not names.
          const bare = w.replace(/[\u2018\u2019]/g, "'").replace(/[^A-Za-z'-]/g, '');
          if (!/^[A-Z]/.test(bare) || /^I'(m|ve|ll|d)$/.test(bare)) return;
          // HW2 (9 Oct): a spelling ("S I O B H A N", "E-L-I-J-A-H") is not a version of the name.
          if (bare.length === 1 || /^[A-Za-z](-[A-Za-z])+$/.test(bare)) return;
          const low = bare.toLowerCase();
          const prev = (toks[i - 1] || '').replace(/[^A-Za-z]/g, '').toLowerCase();
          const sentenceStart = i === 0 || /[.?!]$/.test(toks[i - 1] || '');
          // H2: a capital at a sentence start is an ordinary word ("Thanks, Elijah. Best number for you?").
          if (stop.has(low) || (sentenceStart && !want.includes(low))) return;
          if (!want.includes(low) && (prev === want[0] || want.includes(prev) || !sentenceStart)) said.add(low);
        });
      }
      wrong.name = said.size;
      const finalName = cardName ? nameTokens(cardName) : [];
      const right = finalName.length ? want.every((w) => finalName.includes(w)) : false;
      // H2 (c): the name counts only when the receptionist asked for it or the caller gave it; a call that
      // never got the name has not heard it right.
      const asked = agentTurns.some((t) => /\bname\b|\bspell\b/i.test(t.text) && /\?/.test(t.text));
      const given = caller.some((t) => want.some((w) => norm(t.text).split(' ').includes(w)) || /\b(name is|this is|it's|i'm)\b/i.test(t.text) && finalName.some((w) => norm(t.text).split(' ').includes(w)));
      const got = asked || given;
      // A caller who called the wrong business needs no name taken; if it was taken, it is scored.
      if (got || truth.wants !== 'plumber') items.push({ item: 'name', right: got && right && said.size <= 1, asked, given, wrongVersions: [...said], final: cardName || null, ...(got ? {} : { why: 'never asked or given' }) });
    }
    if (truth.number) {
      const calls = agentTurns.flatMap((t) => t.tools).filter((c) => /number/.test(c.name));
      const last = calls.at(-1);
      const got = String(last?.args?.callback ?? agentTurns.flatMap((t) => t.tools).find((c) => /card/.test(c.name))?.args?.callback ?? '').replace(/\D/g, '');
      const want = String(truth.number).replace(/\D/g, '');
      const tries = calls.filter((c) => String(c.args?.callback ?? '').replace(/\D/g, '') !== want).length;
      items.push({ item: 'number', right: got.endsWith(want.slice(-10)) && tries <= 1, tries: calls.length, final: got || null });
    }
    if (truth.date) {
      const checks = agentTurns.flatMap((t) => t.tools).filter((c) => /check|hold/.test(c.name) && c.args?.date);
      const wrongDates = new Set(checks.map((c) => c.args.date).filter((d) => d !== truth.date));
      const right = checks.some((c) => c.args.date === truth.date) && wrongDates.size <= 1;
      items.push({ item: 'date', right, wrongDates: [...wrongDates] });
    }
    m.heard = items;
    m.heardRight = items.length ? items.filter((x) => x.right).length / items.length : null;
    const wanted = truth.wantsHold === true;
    const held = holds.some((h) => (truth.date ? heldBy(h) === truth.date : true));
    m.dateHeld = wanted ? held : null;
    m.taskRight = broken.length ? 0 : (wanted && !held ? 0.5 : 1);
  } else {
    m.heardRight = null;
    m.notes.push('no truth in the record: "heard right" left out');
    m.taskRight = broken.length ? 0 : 1;
  }
  return m;
}

function stopWords(lineId) {
  const out = ['i', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december', 'thanks', 'bye', 'is', 'okay', 'sorry', 'anything'];
  try {
    const { line } = readLine(lineId || 'harbor');
    for (const v of [line.business, line.owner, line.area, ...(line.towns || []), ...(line.farTowns || [])]) out.push(...wordsOf(v).map((w) => w.toLowerCase()));
  } catch { /* none */ }
  return out;
}

// ------------------------------------------------------------------ scores
/** A part's score 0-100 against its mark (100 at or past the mark, 80 at "allowed", 0 at "far"). */
export function partScore(def, v) {
  if (v === null || v === undefined || Number.isNaN(v)) return null;
  const side = (mark, allowed, far, x, lowerBetter) => {
    const past = lowerBetter ? x <= mark : x >= mark;
    if (past) return 100;
    const d = Math.abs(x - mark);
    const toAllowed = Math.abs(allowed - mark);
    if (toAllowed > 0 && d <= toAllowed) return 100 - (20 * d) / toAllowed;
    const rest = Math.abs(far - allowed);
    const beyond = d - toAllowed;
    return rest > 0 ? Math.max(0, 80 * (1 - beyond / rest)) : 0;
  };
  if (def.better === 'lower') return side(def.mark, def.allowed, def.far, v, true);
  if (def.better === 'higher') return side(def.mark, def.allowed, def.far, v, false);
  if (v < def.mark[0]) return side(def.mark[0], def.allowed[0], def.far[0], v, false);
  if (v > def.mark[1]) return side(def.mark[1], def.allowed[1], def.far[1], v, true);
  return 100;
}

/** The score of one record: every part, the total, close to human or not. */
export function humanScore(rec, opts = {}) {
  const r = readRecord(rec);
  const m = measure(r, opts);
  const parts = [];
  let sum = 0; let weights = 0;
  for (const [key, def] of Object.entries(MARKS.parts)) {
    const score = partScore(def, m[key]);
    parts.push({ key, label: def.label, ours: m[key], mark: def.mark, allowed: def.allowed, score: score === null ? null : Math.round(score) });
    if (score !== null) { sum += score * def.weight; weights += def.weight; }
  }
  const total = weights ? Math.round(sum / weights) : null;
  // H2 (7 Oct 2026): close to human only when EVERY measured part is inside its close band (80 or more)
  // and no rule is broken; a good total can no longer hide a part that fails.
  const outside = parts.filter((p) => p.score !== null && partScore(MARKS.parts[p.key], p.ours) < 80);
  const closeToHuman = total !== null && !outside.length && !m.broken?.length;
  return { id: r.id, kind: r.kind, total, closeToHuman, goal: goalCheck(m), outside: outside.map((p) => p.key), parts, measured: m };
}

const show = (v) => (v === null || v === undefined ? 'n/a' : Array.isArray(v) ? `${v[0]}-${v[1]}` : typeof v === 'number' ? String(Math.round(v * 100) / 100) : String(v));

/** The printout: one line a part, then the total. */
export function scoreText(s) {
  const out = [`Human score, call ${s.id || '(no id)'} (${s.kind} record)`];
  for (const p of s.parts) out.push(`  ${p.label}: ours ${show(p.ours)} | human mark ${show(p.mark)} (close: ${show(p.allowed)}) | ${p.score === null ? 'not measured' : `${p.score}/100`}`);
  if (s.goal) out.push(`  HW goal: median ${show(s.goal.median)} s (${s.goal.medianOk ? 'within' : 'over'} ${GOAL.medianS}), slowest ${show(s.goal.slowest)} s (${s.goal.slowestOk ? 'within' : 'over'} ${GOAL.slowestS}): ${s.goal.ok ? 'MET' : 'NOT MET'}`);
  const m = s.measured;
  if (s.kind === 'bench' && m.benchGap) out.push(`  (the gap above is the bench's own, every turn; Cartesia's agent_turn_ms beside it: ${m.agentTurn ? `no-tool median ${show(m.agentTurn.median)} s, slowest ${show(m.agentTurn.slowest)} s` : 'not in this record'})`);
  else if (m.benchGap) out.push(`  (bench's own gap, end of caller audio to first agent audio: median ${show(m.benchGap.median)} s, slowest ${show(m.benchGap.slowest)} s)`);
  if (m.repeated?.length) out.push(`  said twice: ${m.repeated.map((x) => `"${x}"`).join('; ')}`);
  if (m.stockSaid?.length) out.push(`  stock lines: ${m.stockSaid.map((x) => `"${x}"`).join('; ')}`);
  if (m.heard) out.push(`  heard: ${m.heard.map((h) => `${h.item} ${h.right ? 'right' : 'WRONG'}${h.why ? ` (${h.why})` : ''}${h.final && !h.right && h.item === 'name' ? ` (card: ${h.final})` : ''}${h.wrongVersions?.length ? ` (also said: ${h.wrongVersions.join(', ')})` : ''}`).join('; ')}`);
  for (const b of m.broken || []) out.push(`  BROKEN ${b}`);
  for (const n of m.notes || []) out.push(`  note: ${n}`);
  const outside = s.parts.filter((p) => s.outside?.includes(p.key)).map((p) => `${p.label.split(' (')[0].split(':')[0]} (ours ${show(p.ours)}, close ${show(p.allowed)})`);
  out.push(`TOTAL ${s.total === null ? 'n/a' : `${s.total}/100`} (100 = at the human mark; close to human = every part inside its close band and no rule broken): ${s.closeToHuman ? 'CLOSE TO HUMAN' : 'NOT YET'}`);
  if (outside.length) out.push(`  outside the close band: ${outside.join('; ')}`);
  if (m.broken?.length) out.push(`  rules broken: ${m.broken.length}`);
  return out.join('\n');
}

async function main() {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const li = args.indexOf('--line');
  const lineId = li >= 0 ? args[li + 1] : null;
  const what = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--line');
  if (!what) throw new Error('usage: node bench/human-score.mjs <call.json | callId> [--line harbor] [--json]');
  let rec;
  if (existsSync(what)) rec = JSON.parse(readFileSync(what, 'utf8'));
  else rec = await fetchCall(what, { line: readLine(lineId || 'harbor').line });
  const s = humanScore(rec, { lineId });
  console.log(json ? JSON.stringify(s, null, 1) : scoreText(s));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => { console.error(`human-score: ${err.message}`); process.exitCode = 2; });
}
