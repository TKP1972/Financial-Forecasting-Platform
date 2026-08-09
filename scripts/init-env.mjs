/**
 * Create a working `.env` with real generated secrets.
 *
 * Exists because the documented quick-start did not work. `.env.example` ships
 * placeholder values for four credentials, the API refuses to boot in
 * production with any of them still in place (correctly — a placeholder secret
 * reaching production is a serious problem), and the README only told you to
 * change two of them. Following the instructions literally produced a stack
 * that would not start, which is a poor first impression for someone
 * evaluating the platform.
 *
 * Telling the reader to generate four values by hand would also have fixed it.
 * This is better: the failure was friction, and adding more manual steps is not
 * the way to remove friction.
 *
 *   node scripts/init-env.mjs          # refuses to overwrite an existing .env
 *   node scripts/init-env.mjs --force  # overwrite
 *
 * Values are generated with crypto.randomBytes. The seeded admin password is
 * printed once, because it is the one value you need in order to sign in and
 * it is not recoverable afterwards.
 */
import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const example = join(root, '.env.example');
const target = join(root, '.env');
const force = process.argv.includes('--force');

if (!existsSync(example)) {
  console.error('.env.example not found — run this from the repository root.');
  process.exit(1);
}

if (existsSync(target) && !force) {
  console.error(
    '\n.env already exists. Refusing to overwrite it.\n\n' +
      'Rotating AUDIT_HASH_SALT invalidates verification of every existing audit\n' +
      'entry, so this is not a safe thing to do by accident. Pass --force if you\n' +
      'are certain, or delete .env first.\n',
  );
  process.exit(1);
}

/** URL-safe, no quoting problems in a .env file or a shell. */
const secret = (bytes) => randomBytes(bytes).toString('base64url');

/**
 * A password that satisfies the seed's own complexity rules: at least 12
 * characters with upper, lower, digit and symbol. Generated rather than
 * templated so two installs never share one.
 */
function password() {
  return `Ffp!${secret(12)}9x`;
}

const adminPassword = password();

const replacements = {
  JWT_SECRET: secret(48),
  AUDIT_HASH_SALT: secret(48),
  POSTGRES_PASSWORD: secret(18),
  SEED_ADMIN_PASSWORD: adminPassword,
};

let text = readFileSync(example, 'utf8');
const applied = [];

for (const [key, value] of Object.entries(replacements)) {
  const pattern = new RegExp(`^${key}=.*$`, 'm');
  if (!pattern.test(text)) {
    console.error(`.env.example has no ${key} line — refusing to write a partial .env.`);
    process.exit(1);
  }
  text = text.replace(pattern, `${key}=${value}`);
  applied.push(key);
}

// DATABASE_URL embeds POSTGRES_PASSWORD; leaving the placeholder there would
// produce a .env whose two halves disagree and an API that cannot connect.
text = text.replace(/^DATABASE_URL=.*$/m, (line) =>
  line.replace(/:\/\/([^:]+):([^@]+)@/, `://$1:${replacements.POSTGRES_PASSWORD}@`),
);

if (existsSync(target) && force) copyFileSync(target, `${target}.backup`);
writeFileSync(target, text, 'utf8');

console.log(`\nWrote .env with generated values for: ${applied.join(', ')}`);
if (existsSync(`${target}.backup`)) console.log('Previous .env saved as .env.backup');
console.log(`
  Sign in as:  admin@ffp.local
  Password:    ${adminPassword}

  This is shown once. It is in .env if you lose it.
  .env is gitignored and must never be committed.

Next:  npm install && npm run stack:up   then open http://localhost:8080
`);
