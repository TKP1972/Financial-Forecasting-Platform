/**
 * The production guard must know about every credential shipped in
 * .env.example.
 *
 * The guard originally checked only for a `change_me` marker, which covered
 * JWT_SECRET and AUDIT_HASH_SALT. But POSTGRES_PASSWORD and SEED_ADMIN_PASSWORD
 * ship as real, working values, so a copy-and-fill deployment would keep them
 * and nothing would object - a known password on an account that can approve
 * budgets.
 *
 * Extending the guard fixed today's instance. This test is what stops the next
 * one: add a credential to .env.example without teaching the guard about it and
 * this fails, rather than quietly opening the same hole again.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { KNOWN_EXAMPLE_VALUES } from './config.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/** Keys in .env.example whose value is a credential rather than a setting. */
const CREDENTIAL_KEYS = [
  'JWT_SECRET',
  'AUDIT_HASH_SALT',
  'POSTGRES_PASSWORD',
  'SEED_ADMIN_PASSWORD',
];

function readExample(): Map<string, string> {
  const text = readFileSync(resolve(repoRoot, '.env.example'), 'utf8');
  const values = new Map<string, string>();

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator === -1) continue;
    values.set(trimmed.slice(0, separator), trimmed.slice(separator + 1));
  }

  return values;
}

describe('.env.example credentials are all known to the production guard', () => {
  const example = readExample();

  it('still contains every credential key this test knows about', () => {
    // Guards the test itself: renaming a key in .env.example without updating
    // CREDENTIAL_KEYS would otherwise silently reduce this to checking nothing.
    for (const key of CREDENTIAL_KEYS) {
      expect(example.has(key), `${key} is missing from .env.example`).toBe(true);
    }
  });

  it.each(CREDENTIAL_KEYS)('%s is recognised as a placeholder', (key) => {
    const value = example.get(key) ?? '';

    // Either it carries the marker, or the guard knows the literal value.
    const recognised = value.includes('change_me') || KNOWN_EXAMPLE_VALUES.has(value);

    expect(
      recognised,
      `.env.example sets ${key} to a value the production guard would accept. ` +
        `Either give it a 'change_me' marker, or add the literal to ` +
        `KNOWN_EXAMPLE_VALUES in config.ts.`,
    ).toBe(true);
  });
});
