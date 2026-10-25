#!/usr/bin/env node
// How fast the receptionist answered on one real call (C1, 3 Oct 2026; SPEC
// "Luterson's receptionist, a real, fast, human conversation", Done D1 and D2).
//
//   node tools/call-speed.mjs <callId>               # GET /agents/calls/<id> on the line's own account
//   node tools/call-speed.mjs --file <call.json>     # a call record already saved
//   node tools/call-speed.mjs <callId> --line luterson
//
// READ-ONLY: one GET of the call record on the line's own Cartesia account
// (line.json "cartesiaAccount", the key by lib/accounts.mjs, never printed).
// Nothing is sent anywhere else and nothing is changed.
//
// Each of the receptionist's turns has Cartesia's `agent_turn_ms` (a system
// entry in the transcript, from the caller's last word to the receptionist's
// first): it prints each turn, whether it used a tool, the median of the
// no-tool turns, the slowest turn, and PASS or FAIL against
//   D1  the no-tool turns' median at or under 1.0 s
//   D2  every turn, tools included, at or under 2.0 s
// C2 (4 Oct 2026): a turn that used any tool, the number tool included, is a
// tool turn (D1 counts only the turns with no tool; D2 counts every turn).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readLine } from '../lib/lineagent.mjs';
import { lineAccount, accountKey } from '../lib/accounts.mjs';

// setup.mjs API and VERSION (the same values; not imported, so nothing of setup runs here).
const API = 'https://api.cartesia.ai';
const VERSION = '2026-08-14';
export const D1_MEDIAN_MS = 1000;
export const D2_SLOWEST_MS = 2000;

const toolName = (t) => (typeof t === 'string' ? t : t?.name || t?.function?.name || t?.tool_name || '');

/** The receptionist's turns of a call record: [{ turn, ms, tools, noTool }], in order. */
export function callTurns(call) {
  const entries = Array.isArray(call?.transcript) ? call.transcript : [];
  const turns = [];
  entries.forEach((e, i) => {
    if (e?.role !== 'system' || e.log_metric?.name !== 'agent_turn_ms') return;
    const ms = Number(e.log_metric.value);
    if (!Number.isFinite(ms)) return;
    // the receptionist's words for this turn: the next assistant entry
    const said = entries.slice(i + 1).find((x) => x?.role === 'assistant' || x?.role === 'user');
    const tools = said?.role === 'assistant' && Array.isArray(said.tool_calls) ? said.tool_calls.map(toolName).filter(Boolean) : [];
    turns.push({ turn: turns.length + 1, ms, tools, noTool: tools.length === 0 });
  });
  return turns;
}

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const secs = (ms) => `${(ms / 1000).toFixed(2)} s`;

/** The speed of one call against D1 and D2. */
export function callSpeed(call) {
  const turns = callTurns(call);
  const plain = turns.filter((t) => t.noTool).map((t) => t.ms);
  const med = median(plain);
  const slowest = turns.length ? Math.max(...turns.map((t) => t.ms)) : null;
  const d1 = med !== null && med <= D1_MEDIAN_MS;
  const d2 = slowest !== null && slowest <= D2_SLOWEST_MS;
  return { id: call?.id || '', turns, median: med, slowest, d1, d2, pass: d1 && d2 };
}

/** The printout, one line each. */
export function speedText(s) {
  const out = [`Call ${s.id || '(no id)'}: ${s.turns.length} receptionist turns timed (agent_turn_ms)`];
  for (const t of s.turns) {
    const what = t.noTool ? 'no tool' : `tools ${t.tools.join(', ')}`;
    out.push(`  turn ${t.turn}: ${secs(t.ms)}, ${what}`);
  }
  if (!s.turns.length) out.push('  no agent_turn_ms in this call record');
  out.push(`Median of the no-tool turns: ${s.median === null ? 'none' : secs(s.median)} (D1: at or under 1.0 s) ${s.d1 ? 'PASS' : 'FAIL'}`);
  out.push(`Slowest turn: ${s.slowest === null ? 'none' : secs(s.slowest)} (D2: at or under 2.0 s) ${s.d2 ? 'PASS' : 'FAIL'}`);
  out.push(s.pass ? 'PASS' : 'FAIL');
  return out.join('\n');
}

/** One GET of the call record on the line's own account (read-only). */
export async function fetchCall(callId, { line, home, fetchImpl = fetch } = {}) {
  if (!/^[A-Za-z0-9_-]{4,100}$/.test(String(callId))) throw new Error(`not a call id: ${callId}`);
  const key = accountKey(lineAccount(line), home);
  const res = await fetchImpl(`${API}/agents/calls/${encodeURIComponent(callId)}`, { method: 'GET', headers: { Authorization: `Bearer ${key}`, 'Cartesia-Version': VERSION } });
  if (!res.ok) throw new Error(`Cartesia answered ${res.status} for call ${callId}`);
  return res.json();
}

export function parseSpeedArgs(argv) {
  const opts = { line: 'luterson', file: '', callId: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--line') opts.line = argv[++i];
    else if (a === '--file') opts.file = argv[++i];
    else if (!a.startsWith('--') && !opts.callId) opts.callId = a;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!opts.file && !opts.callId) throw new Error('usage: node tools/call-speed.mjs <callId> | --file <call.json> [--line luterson]');
  return opts;
}

async function main() {
  const opts = parseSpeedArgs(process.argv.slice(2));
  const { line } = readLine(opts.line);
  const call = opts.file ? JSON.parse(readFileSync(opts.file, 'utf8')) : await fetchCall(opts.callId, { line });
  const s = callSpeed(call);
  console.log(speedText(s));
  process.exitCode = s.pass ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => { console.error(`call-speed: ${err.message}`); process.exitCode = 2; });
}
