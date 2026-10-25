// S2 bv2-wire (24 Oct 2026): the moves of Ethan's two real calls (parity-evidence BASELINE-2026-10-23.md), said by the bench's
// callers every run. A move is a fixed line said when the receptionist's last words match a field ask (or an offer, a read-back,
// "anything else"), so the moment happens on every call, not only when the caller model feels like it. Each move is said once.
// The moves never fake what the receptionist heard: only the caller's own words are fixed. A repair move ("A K A R ...",
// "You forgot my first name.") is said only when the receptionist's read-back really was wrong that way.
import { DIGIT_WORDS } from './personas.mjs';

/** The receptionist's last words: its last sentence that asks or offers (else its last sentence). */
export function lastWords(text) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  const parts = s.match(/[^.?!]+[.?!]*/g) || [];
  const q = [...parts].reverse().find((p) => /\?/.test(p));
  return (q || parts.at(-1) || '').trim();
}

/** What the receptionist asks for in its last words, by field (the asks the real calls heard). */
export const ASKS = {
  name: /\b(your|the) (full |first |last |first and last )?name\b|\bwho (am i|i'm) speaking\b|\bspell (that|it|your|the)\b|\bname,? please\b|\bwho('s| is) calling\b/i,
  when: /\bwhen\b[^?]*\b(move|moving|looking|thinking|planning|hoping|like|want)\b|\bwhat (day|date)\b|\bwhich (day|date)\b|\b(a|the) date (in mind|you)\b|\bwhen would\b|\bwhen do you\b/i,
  number: /\b(phone|callback|call-back|call back|contact|best|cell|mobile) number\b|\b(your|a|the) (good |best )?number\b|\bnumber (to reach|for you|we can|i can)\b|\breach you\b|\bnumber (is )?best\b/i,
  anythingElse: /\banything else\b|\bsomething else\b|\banything more\b/i,
  hold: /\b(pencil|hold|reserve|put (you|it|that|this) (down|in)|book (it|that|you|this))\b/i,
};
export const asks = (text, field) => ASKS[field].test(lastWords(text));

const ORD = ['', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth', 'eleventh', 'twelfth', 'thirteenth',
  'fourteenth', 'fifteenth', 'sixteenth', 'seventeenth', 'eighteenth', 'nineteenth', 'twentieth'];
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const suffix = (n) => (n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th');
/** "29" -> "29th". */
export const ordinal = (n) => `${n}${suffix(n)}`;

/** The days of the month the receptionist offers, in the order said ("Tuesday, October 27th, ... and Thursday, October 29th" ->
 * [27, 28, 29]): a day with an ordinal ("27th", "twenty-seventh"), or a number after a month name ("October 29"). */
export function offeredDays(text) {
  const s = String(text || '').toLowerCase().replace(/-/g, ' ');
  const found = [];
  const words = 'twenty|thirty';
  const re = new RegExp(`\\b(?:(\\d{1,2})(?:st|nd|rd|th)\\b|(?:(${words}) )?(${ORD.slice(1).join('|')})\\b|(?:${MONTHS.join('|')}) (\\d{1,2})\\b|(thirtieth))`, 'g');
  for (let m; (m = re.exec(s));) {
    let n = null;
    if (m[1]) n = Number(m[1]);
    else if (m[3]) n = (m[2] === 'twenty' ? 20 : m[2] === 'thirty' ? 30 : 0) + ORD.indexOf(m[3]);
    else if (m[4]) n = Number(m[4]);
    else if (m[5]) n = 30;
    // "first"/"second" alone are not a day ("the first one", "a second"); only with a weekday or month before them
    if (n !== null && m[3] && !m[2] && n <= 3 && !new RegExp(`\\b(${MONTHS.join('|')}|monday|tuesday|wednesday|thursday|friday|saturday|sunday)( the)? $`).test(s.slice(0, m.index))) continue;
    if (n >= 1 && n <= 31) found.push(n);
  }
  return found;
}

/** The sentences of the receptionist's words that offer days (not a day already pencilled in or booked), joined. */
export function offerOf(text) {
  const parts = String(text || '').replace(/\s+/g, ' ').match(/[^.?!]+[.?!]*/g) || [];
  return parts.filter((p) => offeredDays(p).length && /\?|\b(free|open|available|i have|i've got|how about|or|works?|would)\b/i.test(p)
    && !/\b(pencil(l)?ed|booked|held|reserved|confirmed|is in|you're in|all set)\b/i.test(p)).join(' ');
}

/** The ISO date of day-of-month `day` that comes next after today (within 40 days), or null. */
export function isoOfDay(day, today) {
  const d = new Date(`${today}T12:00:00Z`);
  for (let i = 1; i <= 40; i++) {
    d.setUTCDate(d.getUTCDate() + 1);
    if (d.getUTCDate() === day) return d.toISOString().slice(0, 10);
  }
  return null;
}

/** The working days of next week (Mon-Fri after this week) as ISO dates. */
export function nextWeek(today) {
  const d = new Date(`${today}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + ((8 - d.getUTCDay()) % 7 || 7));   // next Monday
  return Array.from({ length: 5 }, (_, i) => { const x = new Date(d); x.setUTCDate(d.getUTCDate() + i); return x.toISOString().slice(0, 10); });
}

/** "3605550731" -> "Three six zero, five, uh, five five five, zero seven three one." (BASELINE §3: "425 7, uh, 443 7927"). */
export function falseStartNumber(digits) {
  const d = String(digits).replace(/\D/g, '').split('').map((x) => DIGIT_WORDS[+x]);
  const line = `${d.slice(0, 3).join(' ')}, ${d[3]}, uh, ${d.slice(3, 6).join(' ')}, ${d.slice(6).join(' ')}.`;
  return line[0].toUpperCase() + line.slice(1);
}

/** The letters the receptionist reads back ("D-I-W-A-K-R", "D, I, W, A, K, R"), as runs per name: ["ELIJAH", "DIWAKR"]. */
export function readBackRuns(text) {
  const s = String(text || '');
  const dashed = s.match(/\b(?:[A-Za-z]-){2,}[A-Za-z]\b/g);
  if (dashed) return dashed.map((r) => r.replace(/-/g, '').toUpperCase());
  return (s.match(/(?:(?<![A-Za-z'’])[A-Za-z](?![A-Za-z'’])[\s,-]*){3,}/g) || []).map((r) => r.replace(/[^A-Za-z]/g, '').toUpperCase());
}

/** The 400-800 ms stops between a spelled line's groups (fixed by the seed, so a run is like the last). */
export const groupPauses = (n, seed = 7) => Array.from({ length: n }, (_, i) => 400 + ((seed * 131 + i * 977) % 401));

/**
 * One caller's moves: next(agentText, ctx) -> {move, text, parts?, pauses?, bye?} or null. ctx.today is the line's today;
 * the moves change the call's truth (xiomara's picked day) through onTruth. done() lists the moves said, in order.
 */
export function makeMoves(persona, { truth = {}, today = '', onTruth = () => {} } = {}) {
  const said = [];
  const once = (move, out) => { if (said.some((m) => m.move === move)) return null; return { move, ...out }; };
  const take = (m, agentText) => { if (m) said.push({ move: m.move, text: m.text, after: lastWords(agentText).slice(0, 120) }); return m; };
  const rules = {
    diwakar: (t) => {
      const first = 'ELIJAH', last = 'DIWAKAR';
      const runs = readBackRuns(t);
      const joined = runs.join('');
      const hasLast = runs.some((r) => r.startsWith('DIW')) || /\bdiwak/i.test(t);
      const hasFirst = runs.includes(first) || joined.startsWith(first) || /\belijah\b/i.test(t);
      const spelledBack = runs.length > 0;
      // a read-back whose last part is wrong: the last name's letters begin right and end wrong ("D, I, W, A, K, R")
      const lastRun = runs.find((r) => r.startsWith('DIW')) || (joined.startsWith(first) ? joined.slice(first.length) : '');
      if (spelledBack && lastRun && lastRun.startsWith('DIW') && lastRun !== last) return once('akar', { text: 'A, K, A, R for the last name, for that last part.' });
      // the first name dropped from a read-back of the name
      if (hasLast && !hasFirst && (spelledBack || /\b(is that|did i|have i|correct|right|got (it|that)|so that's|i have)\b/i.test(t)) && said.some((m) => m.move === 'spell'))
        return once('forgot-first', { text: 'You forgot my first name.' });
      if (asks(t, 'name')) {
        const parts = ['First name, Elijah,', 'E, L, I, J, A, H.', 'Last name, Diwakar,', 'D, I, W, A, K, A, R.'];
        return once('spell', { text: parts.join(' '), parts, pauses: groupPauses(parts.length - 1) });
      }
      return null;
    },
    xiomara: (t) => {
      if (!said.some((m) => m.move === 'pick-last')) {
        const days = offeredDays(offerOf(t));
        if (days.length) {
          const day = days.at(-1);
          const iso = isoOfDay(day, today);
          if (iso) onTruth({ date: iso });
          return once('pick-last', { text: `The ${ordinal(day)} works best.`, day, iso });
        }
      }
      if (asks(t, 'when')) return once('next-week', { text: 'Next week.' });
      if (asks(t, 'number')) return once('false-start', { text: falseStartNumber(truth.number) });
      if (asks(t, 'anythingElse')) return once('thats-it', { text: "No, that'll be it. Thank you.", bye: true });
      return null;
    },
    'siobhan-move': (t) => (asks(t, 'hold') && /\?/.test(lastWords(t)) ? once('yeah-sure', { text: 'Yeah, sure.' }) : null),
    krzysztof: () => null,   // his move is the barge-in (bench/run.mjs bargeFor): said over the receptionist, not after it
  };
  const rule = rules[persona] || (() => null);
  return {
    next: (agentText) => take(rule(String(agentText || '')), agentText),
    note: (move, text, after = '') => { said.push({ move, text, after }); },
    done: () => said.slice(),
  };
}

/** krzysztof's barge-in (R14): the correction he says over the receptionist 0.9 s into its words after the line naming the dresser. */
export const BARGE = { text: 'Sorry, not the dresser. It was the wardrobe that got scratched.', delayMs: 900, after: /\bdresser\b/i };

/** What each caller must say in every run (the judge's scenario list, BENCHMARK-V2.md "Scenarios"); repairs only when earned. */
export const MUST = {
  diwakar: ['spell'],
  xiomara: ['next-week', 'pick-last', 'false-start', 'thats-it'],
  'siobhan-move': ['yeah-sure', 'room', 'laugh'],
  krzysztof: ['barge'],
};
