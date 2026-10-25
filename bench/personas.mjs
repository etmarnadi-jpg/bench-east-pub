// H1 (7 Oct 2026): the bench's callers. Each has a hard name, a real-looking
// number (555-02xx to 555-07xx: in the 555 exchange, which is not given to
// people, and NOT 555-01xx, which the site's number route refuses as made up,
// src/line.js madeUpNumber), what they want, and the
// truth the score checks against (bench/human-score.mjs: name, number, date,
// wantsHold). The words of each turn come from the local model playing the
// persona (bench/run.mjs callerTurn); these briefs are all it is told.
import { spokenDate, workDaysOf } from '../lib/lineagent.mjs';

export const DIGIT_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];

/** "2065550142" -> "two oh six, five five five, zero one four two" (how a person says it). */
export function numberWords(digits) {
  const d = String(digits).replace(/\D/g, '').split('').map((x, i) => (x === '0' && i > 0 && i < 3 ? 'oh' : DIGIT_WORDS[+x]));
  return `${d.slice(0, 3).join(' ')}, ${d.slice(3, 6).join(' ')}, ${d.slice(6).join(' ')}`;
}

export const PERSONAS = {
  diwakar: { name: 'Elijah Diwakar', number: '4255550247', wants: 'date', from: 'a two-bedroom apartment', accent: 'indian',
    brief: 'You are moving out of a two-bedroom apartment and want to book a moving day.' },
  nguyen: { name: 'Thanh Nguyen', number: '2065550263', wants: 'nodate', from: 'a one-bedroom condo', accent: 'vietnamese',
    brief: 'You are moving sometime next month but do not have a date yet; you want to know how it works and get a call back. Do not agree to a date.' },
  siobhan: { name: 'Siobhan Kelly', number: '3605550318', wants: 'plumber', accent: 'irish',
    brief: 'You think you called a plumber: your kitchen sink is leaking. You are surprised to reach a moving company. You do not want a move.' },
  oluwaseun: { name: 'Oluwaseun Adeyemi', number: '2535550429', wants: 'urgent', from: 'a studio', accent: 'south-african',
    brief: 'You must move out THIS week: your lease ends in three days and your landlord is pushing you. You are stressed and want the soonest possible help.' },
  // H2: Siobhan again, booking a move this time, so her name has to reach the card.
  'siobhan-move': { name: 'Siobhan Kelly', number: '3605550327', wants: 'date', from: 'a one-bedroom apartment', accent: 'irish',
    brief: 'You are moving out of a one-bedroom apartment and want to book a moving day.' },
  krzysztof: { name: 'Krzysztof Nowak', number: '4255550586', wants: 'owner', accent: 'british',
    brief: 'You moved with this company last year and want to speak to the owner himself about a scratched dresser. You do not want to book anything.' },
  priya: { name: 'Priya Raghunathan', number: '2065550674', wants: 'mind', from: 'a three-bedroom house', accent: 'singaporean',
    brief: 'You want to book a moving day. First ask for the FIRST date below. After the receptionist answers about it, change your mind: say your closing moved and you need the SECOND date instead.' },
  xiomara: { name: 'Xiomara Delgado', number: '3605550731', wants: 'date', from: 'a two-bedroom townhouse', accent: 'spanish',
    brief: 'You are moving out of a townhouse and want to book a moving day.' },
};

/** "Thanh Nguyen" -> "T, H, A, N, H ... N, G, U, Y, E, N" (each name letter by letter). */
export const spelled = (name) => String(name).split(/\s+/).map((w) => w.toUpperCase().split('').join(', ')).join(' ... ');

const isoOf = (d) => d.toISOString().slice(0, 10);
const DAY_KEYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** A working, free day at least `after` days from today on the line (the facts in its line.json). */
export function freeDay(line, today, after = 10) {
  const days = workDaysOf(line);
  const taken = new Set(line.taken || []);
  const d = new Date(`${today}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + Math.max(after, Number(line.daysAhead) || 0));
  for (let i = 0; i < 60; i++, d.setUTCDate(d.getUTCDate() + 1)) {
    const iso = isoOf(d);
    if (days.includes(DAY_KEYS[d.getUTCDay()]) && !taken.has(iso)) return iso;
  }
  throw new Error('no free working day in 60 days on this line');
}

/** The persona's truth for one call: what the score checks. */
export function personaTruth(id, line, today) {
  const p = PERSONAS[id];
  if (!p) throw new Error(`no persona "${id}"; use one of ${Object.keys(PERSONAS).join(', ')}`);
  const truth = { persona: id, name: p.name, number: p.number, wants: p.wants, wantsHold: false };
  if (p.wants === 'date') { truth.date = freeDay(line, today, 10); truth.wantsHold = true; }
  if (p.wants === 'mind') { truth.firstDate = freeDay(line, today, 9); truth.date = freeDay(line, today, 16); truth.wantsHold = true; }
  return truth;
}

/** What the local model is told: who it is, what it wants, how a caller talks. */
export function callerPrompt(id, truth, line) {
  const p = PERSONAS[id];
  const facts = [
    // H2: the caller can spell either name (the hearing probe lost first names like Krzysztof, not only last names).
    `Your name: ${p.name}. If asked to spell it, spell the part they ask about letter by letter; if they just ask you to spell your name, spell both: "${spelled(p.name)}".`,
    `Your phone number: ${numberWords(p.number)}. When asked for it, say it in words, grouped like that.`,
  ];
  if (p.from) facts.push(`You live in ${p.from} in ${line.towns?.[0] || 'town'} and are moving to ${line.towns?.[1] || 'the next town'}.`);
  if (truth.wants === 'date') facts.push(`The day you want: ${spokenDate(truth.date)}. Say it like that.`);
  if (truth.wants === 'mind') facts.push(`FIRST date: ${spokenDate(truth.firstDate)}. SECOND date: ${spokenDate(truth.date)}.`);
  return [
    `You are a person phoning ${line.business || 'a moving company'}. You are the CALLER, not the receptionist.`,
    p.brief,
    ...facts,
    'How you talk: like a real person on the phone. One or two short sentences a turn. Answer what the receptionist just said; give a fact only when asked or when it is the natural next thing. Do not say your name and number and date all at once.',
    'If the receptionist offers to pencil in or hold the date you want, say yes in your own words. If they read your number back, say whether it is right; if it is wrong, say it again. "Oh" and "zero" are the same digit: a read-back with either is right.',
    'When everything is done, or the receptionist says goodbye, say a short goodbye and set "hangUp" to true.',
    'Reply as JSON: {"say": "<your words, plain text>", "hangUp": false}.',
  ].join('\n');
}
