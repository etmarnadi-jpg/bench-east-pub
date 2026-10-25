// One Cartesia account per line (L1e, 30 September 2026; Ethan, 29 Sep 2026:
// "3 api keys from 3 different accounts ... work that into the plumbing").
//
// Each account has one key file in ~/ethan/secrets (chmod 600):
//   A  cartesia-api-key      the two demo phone robots
//   B  cartesia-api-key-b    Luterson's line
//   C  cartesia-api-key-c    spare
//   D  cartesia-api-key-d    spare
// A line names its account in its line.json ("cartesiaAccount": "b"); the demo
// robots are always on A. Minutes are paid from the credit on the line's own
// account. Keys are read only through lib/keys.mjs and only their last four
// are ever said.
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { readKey, lastFour, secretPath } from './keys.mjs';

export const ACCOUNTS = ['a', 'b', 'c', 'd'];
export const DEMO_ACCOUNT = 'a';

/** The key file's name in ~/ethan/secrets for an account letter. */
export const accountFile = (letter) => (letter === 'a' ? 'cartesia-api-key' : `cartesia-api-key-${letter}`);
export const upper = (letter) => String(letter).toUpperCase();

/** A checked account letter (a-d, any case), or a plain sentence saying what is wrong. */
export function checkLetter(letter, where) {
  const l = String(letter ?? '').trim().toLowerCase();
  if (!ACCOUNTS.includes(l)) throw new Error(`${where}: "${letter ?? ''}" is not one of the Cartesia accounts; use a, b, c or d`);
  return l;
}

/** The account a line is on. Every line must name one. */
export function lineAccount(line) {
  if (line.cartesiaAccount === undefined) {
    throw new Error(`${line.id}/line.json does not say which Cartesia account the line is on; add "cartesiaAccount": "b" (or a, c, d)`);
  }
  return checkLetter(line.cartesiaAccount, `${line.id}/line.json "cartesiaAccount"`);
}

/**
 * The account's key. A missing, empty or unreadable key file stops with a
 * plain sentence naming the file. The key itself is never in a message.
 */
export function accountKey(letter, home = homedir()) {
  const name = accountFile(letter);
  const file = secretPath(name, home);
  const who = `The key file for Cartesia account ${upper(letter)}, ${file},`;
  let key;
  try {
    key = readKey(name, home);
  } catch (err) {
    const why = /can be read by others/.test(err.message) ? 'others can read it; it must be chmod 600'
      : err.code === 'EACCES' ? 'this user is not allowed to read it'
        : err.code === 'EISDIR' ? 'it is a folder, not a file'
          : `the system said ${err.code || 'no'}`;
    throw new Error(`${who} cannot be read: ${why}.`);
  }
  if (key === null) {
    throw new Error(existsSync(file) ? `${who} has no key in it.` : `${who} is missing. Put that account's API key in it (chmod 600) and run again.`);
  }
  return key;
}

/** "Cartesia account B (key ending iFNx)". */
export const accountLabel = (letter, key) => `Cartesia account ${upper(letter)} (key ending ${lastFour(key)})`;

/** Every account key that can be read, for scrubbing output. Never throws. */
export function allAccountKeys(home = homedir()) {
  const keys = [];
  for (const l of ACCOUNTS) {
    try { keys.push(readKey(accountFile(l), home)); } catch { /* not readable: nothing to scrub */ }
  }
  return keys.filter(Boolean);
}

/** From a usage/billing reply, only the fields that speak of credit, balance or money. */
export function creditFields(value, prefix = '', out = {}) {
  if (value === null || typeof value !== 'object') return out;
  for (const [k, v] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (/key|secret|token/i.test(k)) continue;
    if (v !== null && typeof v === 'object') creditFields(v, path, out);
    else if (/credit|balance|remain|prepaid|dollar|usd|cents|amount|spent|minutes|overage/i.test(k)) out[path] = v;
  }
  return out;
}

const names = (list, pick) => (list.length ? ` (${list.map(pick).join('; ')})` : '');

/**
 * --look --all-accounts (read only, GETs only). For each account whose key
 * file is present: one line with the letter, the key's last four, the agents,
 * tools and numbers, and the credit fields if the API gives them. An account
 * that refuses or does not answer gets that said on its line, and the look goes on.
 *   makeCall(key) -> call(method, path) (setup.mjs's client, one per key)
 *   all(call, path) -> every item on every page (setup.mjs's all)
 */
export async function lookAllAccounts({ home = homedir(), makeCall, all, say, now = new Date() }) {
  const seen = {};
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  for (const l of ACCOUNTS) {
    const L = upper(l);
    if (!existsSync(secretPath(accountFile(l), home))) {
      say(`${L}  no key file (${accountFile(l)}): not given yet`);
      seen[l] = { present: false };
      continue;
    }
    let key;
    try {
      key = accountKey(l, home);
    } catch (err) {
      say(`${L}  ${err.message}`);
      seen[l] = { present: true, readable: false };
      continue;
    }
    const call = makeCall(key);
    let agents; let tools; let numbers;
    try {
      agents = await all(call, '/v1/agents');
      tools = await all(call, '/v1/agents/tools');
      numbers = await all(call, '/agents/phone-numbers');
    } catch (err) {
      const why = err.status ? `refused, answered ${err.status}` : 'not reachable, no answer';
      say(`${L}  key ending ${lastFour(key)}: ${why}; going on`);
      seen[l] = { present: true, keyEnds: lastFour(key), refused: err.status || 'no answer' };
      continue;
    }
    let credit;
    try {
      const usage = await call('GET', `/usage/agents?start_ts=${encodeURIComponent(start)}`);
      const fields = creditFields(usage);
      credit = Object.keys(fields).length ? `credit ${JSON.stringify(fields)}` : 'credit: the API answered with no credit or balance fields';
    } catch (err) {
      credit = `credit: not readable with this key (answered ${err.status || 'nothing'})`;
    }
    say(`${L}  key ending ${lastFour(key)}: agents ${agents.length}${names(agents, (a) => a.name)}, tools ${tools.length}${names(tools, (t) => t.name)}, numbers ${numbers.length}${names(numbers, (p) => `${p.number} -> ${p.agent?.name || p.agent_id || 'no agent'}`)}, ${credit}`);
    seen[l] = { present: true, keyEnds: lastFour(key), agents: agents.map((a) => ({ id: a.id, name: a.name })), tools: tools.map((t) => ({ id: t.id, name: t.name })), numbers: numbers.map((p) => ({ id: p.id, number: p.number, agent: p.agent_id || p.agent?.id || null })), credit };
  }
  return seen;
}
