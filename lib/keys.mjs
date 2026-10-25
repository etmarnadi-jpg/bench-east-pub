// The only place ~/ethan/robot-line reads a key. A key is never returned in
// an error, never logged and never printed; `lastFour` is the only part of one
// this folder will ever say out loud.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const secretPath = (name, home = homedir()) => join(home, 'ethan', 'secrets', name);

/** The key in ~/ethan/secrets/<name>, or null. Refuses a file others can read. */
export function readKey(name, home = homedir()) {
  const file = secretPath(name, home);
  if (!existsSync(file)) return null;
  const mode = statSync(file).mode & 0o777;
  if (mode & 0o077) throw new Error(`${file} can be read by others (mode ${mode.toString(8)}); it must be 600`);
  const key = readFileSync(file, 'utf8').split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith('#'));
  return key || null;
}

export const lastFour = (key) => (key ? String(key).slice(-4) : '----');
