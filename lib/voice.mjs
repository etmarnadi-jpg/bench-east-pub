// What Cartesia is sent, built fresh from the robot's own files on every run.
//
// ONE SOURCE. The typed demo's prompt (`~/ethan/robot-demo/prompts/<trade>.md`)
// and trade file (`~/ethan/robot-demo/trades/<trade>.json`) are read each time
// this runs and never copied here. The prompts are still being tuned by
// another phase, so a copy would be wrong within the day.
//
// WHAT A VOICE CALL NEEDS THAT A TYPED CALL DOES NOT, and nothing else. The
// rules, the business facts, the slots and the manner are the prompt's own
// words, untouched. What changes, each written down in ADAPTATIONS below:
//   1. The typed service fills {{TODAY}}, {{NOW}}, {{OFFERS}} and {{PRICES}}
//      per turn. A hosted agent cannot, so: the clock is Cartesia's own
//      {{system__time}} (agent time zone America/Chicago), the free times are
//      the trade file's booking window stated as a rule, and the price sheet
//      is written in from the trade file (the same lines demo.mjs writes).
//   2. The typed robot answers in a JSON card (`heard`, `area`, `say`, `why`,
//      `urgency`, `slots`, `booked`, `ended`). On the phone every word written
//      is spoken aloud, so that whole section is taken out and replaced by
//      one that says: speak only, the card is sent with a tool at the end, the
//      booking is made with a tool, and the call is ended with end_call.
//   3. The prompt's own rule text is NOT rewritten, because it is being tuned
//      by another phase and a phrase-by-phrase rewrite breaks the day it
//      changes. Instead the added section says what three typed-call words
//      mean on the phone: `ended` true is "send the card, say the last line,
//      end_call"; `booked` is "use the booking tool"; and "putting them
//      through to the plumber" (the demo line has no phone to hand a call
//      to, and Cartesia only transfers on a Twilio or SIP number) is "say the
//      plumber will call them straight back", with the rest of that rule
//      (book nothing, end the call) unchanged.
//
// If the prompt changes shape so that a REQUIRED change no longer applies (the
// section heading is renamed, a placeholder moves), `voicePrompt` throws rather
// than send Cartesia a prompt that asks the phone line to speak JSON.

import { lastFour } from './keys.mjs';

export const SITE = 'https://aivorlabs.etmarnadi.workers.dev';
export const MODEL = 'gpt-5.4-mini';
// The voice in Cartesia's own agent-configuration example
// (docs.cartesia.ai/agents/configuration, read 22 September 2026). `--really`
// checks it exists with GET /voices/{id} before anything is created.
export const VOICE = 'e07c00bc-4134-4eae-9ea4-1a55fb45746b';
export const TIMEZONE = 'America/Chicago';

/** Per trade: the agent's name and its two tools. */
export const LINES = {
  plumbing: {
    agent: 'Summit Comfort (Aivorlabs demo line)',
    book: 'summit_book_job',
    card: 'summit_send_card',
    thing: 'time',
    urgency: ['EMERGENCY', 'TODAY', 'THIS WEEK'],
  },
  moving: {
    agent: 'Northstar Movers (Aivorlabs demo line)',
    book: 'northstar_hold_date',
    card: 'northstar_send_card',
    thing: 'date',
    urgency: ['QUOTE'],
  },
};

/** The price sheet, exactly as demo.mjs writes it. */
export function priceSheet(trade) {
  if (!Array.isArray(trade.sizes)) return '';
  return trade.sizes.map((s) => `- ${s.label}, local: usually ${s.ballpark}`).join('\n');
}

/**
 * The free times, as a rule the agent applies to the clock itself.
 *
 * demo.mjs works the list out per turn (`plumbingOffers`, `movingOffers`);
 * this is the same rule in words, starting from the trade file's own
 * `bookingWindow` sentence.
 */
export function offersRule(trade) {
  if (trade.id === 'moving') {
    return [
      `- ${trade.bookingWindow}`,
      '- Work the dates out yourself from today\'s date above: the first Saturday that is at least two days away is offered first, then the next working day after it. Never a Sunday, never today or tomorrow.',
      '- Say a date the way a person does ("Saturday the 26th"), never as numbers with slashes.',
    ].join('\n');
  }
  return [
    `- ${trade.bookingWindow}`,
    '- Work the free times out yourself from the time above: the two soonest two-hour slots from that list, never one that starts within the next hour, never on a Sunday, and never outside the hours.',
    '- Say a slot the way a person does ("tomorrow, eight to ten"), never as numbers with a dash.',
  ].join('\n');
}

function voiceSection(trade, line) {
  const owner = trade.owner;             // "the plumber" / "the owner"
  const moving = trade.id === 'moving';
  const urg = moving
    ? '`urgency` is always QUOTE.'
    : '`urgency` is one of EMERGENCY, TODAY or THIS WEEK, and once EMERGENCY it stays EMERGENCY.';
  return `## On the phone: what you say, and what you send

This is a real phone call. The caller hears every word you write, spoken
aloud, and nothing else.

- Write only the words you say. No markdown, no lists, no headings, no
  symbols, no emoji, no JSON, no field names, no tool names and nothing in
  backticks. Never read out the card or anything you are noting down.
- Say numbers the way a person says them out loud: "eight to ten tomorrow",
  "six hundred to nine hundred dollars". Never "8-10" or "$600".
- On the phone, "a line you cannot read" means words you could not make out
  or that make no sense. Say so and ask them to say it again, in new words
  each time.
- Where these rules speak of your card, or of a fact in backticks (${trade.slots.map((s) => `\`${s.key}\``).join(', ')}, \`why\`),
  that is the note you keep for ${owner} during the call. You never say it.
  You send it once, at the end, with the ${line.card} tool. ${urg}
- Where these rules say to put a ${line.thing} into \`booked\`: the moment the
  caller agrees a ${line.thing}, use the ${line.book} tool with that ${line.thing} word for word and
  the facts you have. Only once it answers, say the ${line.thing} back. If it could not
  ${moving ? 'hold the date' : 'book'}, say ${owner} will call them to fix a ${line.thing}; never pretend it worked.
  Use it once on a call, never for a caller outside the area, never after a
  gas smell, and never when the call was handed over.
- Where these rules say \`ended\` true (or "set \`ended\` true"), that means:
  send the card, say that last line, then end the call with end_call.
- Where these rules say you are putting them through to ${owner}: this
  line cannot put anyone through. Say instead that ${owner} will call them
  straight back, in a moment. The rest of that rule stands: book nothing,
  send the card, end the call.
- Ending the call. Just before a call ends, whatever way it ends (${moving ? 'a held date' : 'a booking'} and
  goodbye, ${moving ? '' : 'gas, '}a caller who asks for a person, outside the area, a wrong
  number, "never mind"), use the ${line.card} tool once with the card: \`why\`
  in your own words (at most eight, never theirs), the urgency, what was
  ${moving ? 'held' : 'booked'} (or nothing), and the facts they gave. Then say your last line and
  end the call with end_call. Never end a call without sending the card, and
  never send it twice.
`;
}

/**
 * Every `{{slot}}` in `text` that nothing filled: all but Cartesia's own
 * `{{system__time}}`. setup.mjs refuses to send anything that has one (L1c).
 */
export function unfilledSlots(text) {
  return [...String(text).matchAll(/\{\{\s*([^{}]*?)\s*\}\}/g)].map((m) => m[1]).filter((v) => v !== 'system__time');
}

/**
 * The instructions Cartesia's agent is given, and the list of what was changed.
 * Throws if a required change cannot be made.
 */
export function voicePrompt(promptText, trade) {
  const line = LINES[trade.id];
  if (!line) throw new Error(`no phone line is set up for the trade "${trade.id}"`);
  const applied = [];
  const warnings = [];
  let text = String(promptText);

  const cut = /\n## What you write\b[^\n]*/.exec(text);
  if (!cut) throw new Error(`prompts/${trade.id}.md has no "## What you write ..." section; the prompt changed shape, so nothing is sent`);
  const cutHeading = cut[0].trim();
  text = text.slice(0, cut.index).trimEnd();
  applied.push(`took out "${cutHeading}" (the JSON card the typed robot writes) and everything after it`);

  const clock = /It is \{\{TODAY\}\}, \{\{NOW\}\}\./;
  if (!clock.test(text)) throw new Error(`prompts/${trade.id}.md has no "It is {{TODAY}}, {{NOW}}." line`);
  text = text.replace(clock, 'It is {{system__time}}, Chicago time.');
  applied.push('"It is {{TODAY}}, {{NOW}}." became Cartesia\'s own clock, "It is {{system__time}}, Chicago time."');

  if (!text.includes('{{OFFERS}}')) throw new Error(`prompts/${trade.id}.md has no {{OFFERS}}`);
  text = text.replaceAll('{{OFFERS}}', offersRule(trade));
  applied.push('{{OFFERS}} (a list demo.mjs works out per turn) became the trade file\'s booking window, as a rule the agent applies to the clock');

  if (text.includes('{{TOWNS}}')) {
    // The same source and the same words as the typed robot (robot-demo
    // demo.mjs townList: the trade file's `towns`, joined with ", "), never a
    // copied list (L1c, 29 Sep 2026: fix part D added the slot to both prompts).
    if (!Array.isArray(trade.towns) || !trade.towns.length || trade.towns.some((t) => typeof t !== 'string' || !t.trim())) {
      throw new Error(`prompts/${trade.id}.md has {{TOWNS}} but trades/${trade.id}.json has no "towns" list`);
    }
    text = text.replaceAll('{{TOWNS}}', trade.towns.join(', '));
    applied.push('{{TOWNS}} became the trade file\'s "towns", joined the way demo.mjs joins them');
  }

  if (text.includes('{{PRICES}}')) {
    text = text.replaceAll('{{PRICES}}', priceSheet(trade));
    applied.push('{{PRICES}} became the price sheet from the trade file, the same lines demo.mjs writes');
  }

  text = `${text}\n\n${voiceSection(trade, line)}`;
  applied.push('added "## On the phone" at the end: speak only; `booked` means the booking tool; the card goes with the card tool at the end; `ended` true means send the card, say the last line, end_call; "putting them through" means "the ' + trade.owner.replace(/^the /, '') + ' will call them straight back"');

  const left = unfilledSlots(text);
  if (left.length) throw new Error(`prompts/${trade.id}.md still has placeholders nothing fills: ${left.join(', ')}`);
  for (const gone of ['**heard**', '**say**', '**area**']) {
    if (text.includes(gone)) throw new Error(`the voice prompt still describes ${gone}, which only makes sense for the typed JSON card`);
  }
  return { instructions: text, applied, warnings };
}

// ---------------------------------------------------------------------------
// the two tools
// ---------------------------------------------------------------------------

/**
 * The booking-key header. Cartesia stores `secret_value` and never returns
 * it; `secret_description` is stored as plain text and returned, so it carries
 * the key's last four (never more) and the read-back can tell which key the
 * tool holds.
 */
export function bookHeader(keyValue) {
  return { type: 'secret', secret_value: keyValue, secret_description: `Aivorlabs booking key, ends ${lastFour(keyValue)}` };
}

const str = (description, extra = {}) => ({ type: 'string', description, ...extra });

function slotProps(trade) {
  const props = {};
  for (const s of trade.slots) props[s.key] = str(`${s.label}: the short fact the caller gave, in a few words, never their whole sentence. Leave out if not given.`);
  return props;
}

/** POST /v1/agents/tools body for the booking tool. `keyValue` is the book key. */
export function bookTool(trade, site, keyValue) {
  const line = LINES[trade.id];
  const moving = trade.id === 'moving';
  const props = {
    trade: { type: 'string', constant_value: trade.id },
    callId: { type: 'string', dynamic_variable: 'system__conversation_id' },
    ...slotProps(trade),
    why: str('What the job is, in your own words, at most eight words.'),
  };
  props.when.description = moving
    ? 'The date the caller agreed, word for word as you offered it, like "Saturday the 26th".'
    : 'The slot the caller agreed, word for word as you offered it, like "Tomorrow 8 to 10".';
  if (moving) props.callback = str('The number the caller gave to be called back on, digits only. Leave out if not given.');
  else props.urgency = str('How urgent the job is.', { enum: line.urgency });
  return {
    type: 'webhook',
    name: line.book,
    description: moving
      ? `Holds a moving date on ${trade.business}'s calendar. Use it once, the moment the caller agrees a date and you know both ends of the move. Send the date exactly as you offered it.`
      : `Books the job on ${trade.business}'s calendar. Use it once, the moment the caller agrees one of the free times and you have the problem and the address inside the area. Send the time exactly as you offered it.`,
    pre_tool_speech: 'auto',
    execution_mode: 'immediate',
    response_timeout_secs: 10,
    api_schema: {
      url: `${site}/api/demo/book`,
      method: 'POST',
      request_headers: { 'X-Book-Key': bookHeader(keyValue) },
      request_body_schema: {
        type: 'object',
        properties: props,
        // Cartesia refuses a `required` field that is filled by constant_value or
        // dynamic_variable (400, found on 23 September 2026), so `trade` and
        // `callId` are sent on every call but never listed here.
        required: moving ? ['when'] : ['when', 'problem', 'where', 'urgency'],
      },
    },
  };
}

/** POST /v1/agents/tools body for the card tool. */
export function cardTool(trade, site, keyValue) {
  const line = LINES[trade.id];
  return {
    type: 'webhook',
    name: line.card,
    description: `Sends ${trade.owner} the card for this call: what it is about, how urgent it is, what was ${trade.id === 'moving' ? 'held' : 'booked'}, and the facts the caller gave. Use it exactly once, just before the call ends, whatever way it ends.`,
    pre_tool_speech: 'auto',
    execution_mode: 'async',
    response_timeout_secs: 10,
    api_schema: {
      url: `${site}/api/demo/card`,
      method: 'POST',
      request_headers: { 'X-Book-Key': bookHeader(keyValue) },
      request_body_schema: {
        type: 'object',
        properties: {
          trade: { type: 'string', constant_value: trade.id },
          callId: { type: 'string', dynamic_variable: 'system__conversation_id' },
          why: str('What the call was about, in your own words, at most eight words. Never the caller\'s own words.'),
          urgency: str('How urgent it is.', { enum: line.urgency }),
          booked: str(`The ${line.thing} that was ${trade.id === 'moving' ? 'held' : 'booked'}, as you said it, or an empty string if nothing was.`),
          ended: { type: 'boolean', constant_value: true },
          slots: { type: 'object', description: 'The facts the caller gave.', properties: slotProps(trade) },
        },
        required: ['why', 'urgency', 'booked'],
      },
    },
  };
}

/** POST /v1/agents body (PATCH takes the same, with version_description). */
export function agentBody(trade, instructions, toolIds, { model = MODEL, voice = VOICE } = {}) {
  const line = LINES[trade.id];
  return {
    name: line.agent,
    description: `Aivorlabs demo line for ${trade.business}. Made by ~/ethan/robot-line/setup.mjs from robot-demo/prompts/${trade.id}.md and trades/${trade.id}.json; change those and run the script again rather than editing here.`,
    config: {
      instructions,
      initial_message: trade.greeting,
      timezone: TIMEZONE,
      model: { id: model, temperature: 0.4 },
      language: { primary: 'en' },
      audio: {
        input: { noise_suppression: 'auto', keyterms: [trade.business, ...trade.towns].slice(0, 20) },
        output: { voice_id: voice },
      },
      tools: toolIds.map((id) => ({ id })),
      system_tools: {
        end_call: {
          description: 'End the call, only after the card has been sent and your last line has been said.',
          pre_tool_speech: 'force',
        },
        send_dtmf: null,
        transfer_to_number: null,
      },
    },
  };
}
