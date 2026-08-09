/**
 * Environment configuration.
 *
 * Validated once at boot and then frozen. A missing or weak secret fails the
 * process immediately rather than surfacing as a subtle auth bug in production -
 * there is no "sensible default" for a signing key.
 */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { DEFAULT_CURRENCY } from '@ffp/shared';

/**
 * Load the repo-root .env when running outside a container.
 *
 * In Docker the environment is injected by compose and no file exists, which is
 * why a missing file is not an error. Real environment variables always win:
 * loadEnvFile does not overwrite anything already set.
 */
function loadDotEnv(): void {
  if (process.env.SKIP_DOTENV === 'true') return;
  const here = dirname(fileURLToPath(import.meta.url));
  // src/ during dev, dist/ once built - both are two levels under packages/api.
  for (const candidate of [
    resolve(here, '../../../.env'),
    resolve(here, '../../../../.env'),
    resolve(process.cwd(), '.env'),
  ]) {
    if (existsSync(candidate)) {
      try {
        process.loadEnvFile(candidate);
      } catch {
        // A malformed .env should surface as a validation error below, with the
        // specific missing keys named, rather than as an opaque parse failure.
      }
      return;
    }
  }
}

loadDotEnv();

/**
 * Boolean environment variable.
 *
 * Same trap as query strings: `z.coerce.boolean()` applies JS truthiness, so the
 * string "false" would become `true` and a flag someone explicitly turned off
 * would be on.
 */
const FALSEY_ENV = new Set(['false', '0', 'no', 'off', '']);
const queryBooleanEnv = z.preprocess((value) => {
  if (typeof value === 'string') return !FALSEY_ENV.has(value.trim().toLowerCase());
  return value;
}, z.boolean());

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  API_HOST: z.string().default('0.0.0.0'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

  JWT_SECRET: z
    .string()
    .min(
      32,
      "JWT_SECRET must be at least 32 characters. Generate one with: node -e \"console.log(require('crypto').randomBytes(48).toString('hex'))\"",
    ),
  JWT_ACCESS_TTL: z.coerce.number().int().min(60).default(900),
  JWT_REFRESH_TTL: z.coerce.number().int().min(300).default(604800),

  AUDIT_HASH_SALT: z.string().min(32, 'AUDIT_HASH_SALT must be at least 32 characters'),

  /**
   * Currency applied to records that do not state one: business units, budget
   * cycles, budgets, rate cards and pricing models.
   *
   * One deployment-level decision, replacing what used to be nine independent
   * `'USD'` literals across the schema, the contracts and the engine. It is not
   * an FX setting - the platform stores amounts in the currency they were
   * entered in and does not translate between them (see architecture.md). This
   * only decides what a record gets when the caller says nothing.
   */
  BASE_CURRENCY: z.string().length(3).default(DEFAULT_CURRENCY),

  CORS_ORIGIN: z.string().default('http://localhost:5173'),
  RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(300),
  RATE_LIMIT_WINDOW: z.coerce.number().int().min(1000).default(60000),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  /**
   * Human-readable log output via pino-pretty.
   *
   * Separate from NODE_ENV because pino-pretty is a devDependency and is not in
   * the production image. Inferring this from NODE_ENV meant that running a
   * container with NODE_ENV=development - the only way to exercise some
   * development-only behaviour - crashed at boot on a missing transport.
   * Defaults to on outside production; set it to false explicitly for a
   * container built without dev dependencies.
   */
  LOG_PRETTY: queryBooleanEnv.optional(),

  SEED_ADMIN_EMAIL: z.string().email().default('admin@ffp.local'),
  SEED_ADMIN_PASSWORD: z.string().min(12).default('Adm1n!Local2026'),

  /** Maximum failed logins before the account locks. */
  MAX_LOGIN_ATTEMPTS: z.coerce.number().int().min(1).default(5),
  /** Lockout duration in seconds. */
  LOGIN_LOCKOUT_SECONDS: z.coerce.number().int().min(30).default(900),

  /** Public URL of the web app, used to build links inside notifications. */
  APP_URL: z.string().default('http://localhost:8080'),

  /**
   * Delivery transport. `log` writes the message to the application log and is
   * the default deliberately - a platform should not gain the ability to email
   * real people as a side effect of configuration drift. `none` queues without
   * delivering, which is useful when running the API purely as an API.
   */
  NOTIFICATION_TRANSPORT: z.enum(['log', 'none']).default('log'),
  /** Seconds between dispatcher runs. 0 disables the background dispatcher. */
  NOTIFICATION_DISPATCH_SECONDS: z.coerce.number().int().min(0).default(60),
  /** Seconds between deadline scans. 0 disables the scanner. */
  DEADLINE_SCAN_SECONDS: z.coerce.number().int().min(0).default(3600),

  /**
   * Seconds between audit-chain anchor emissions. 0 disables anchoring.
   *
   * An anchor is the chain head - sequence and hash - written somewhere the
   * database cannot reach. It is what makes tail truncation detectable, and what
   * turns a rewrite by someone holding AUDIT_HASH_SALT into something that can
   * be caught. The interval is the residual window: entries newer than the last
   * anchor are not covered.
   */
  AUDIT_ANCHOR_SECONDS: z.coerce.number().int().min(0).default(3600),

  /**
   * Optional append-only file for anchors, as JSON Lines.
   *
   * The application log always receives anchors. A file is useful when the log
   * is not shipped off-host; it should live on a different volume from the
   * database, and ideally one the API user can append to but not rewrite.
   */
  AUDIT_ANCHOR_FILE: z.string().optional(),

  /**
   * Return the password reset token in the API response.
   *
   * Only for local development and the smoke test, which have no mailbox to read.
   * Refused in production below - it would turn "I know an email address" into
   * "I own that account".
   */
  PASSWORD_RESET_EXPOSE_TOKEN: queryBooleanEnv.default(false),
});

export type AppConfig = Readonly<z.infer<typeof envSchema>> & {
  readonly isProduction: boolean;
  readonly isTest: boolean;
  readonly corsOrigins: readonly string[];
};

/**
 * Values that appear verbatim in .env.example.
 *
 * Kept in step with that file by config.test.ts, which reads it and fails if a
 * credential there is not represented here - so adding a new example value
 * cannot silently create a production hole.
 */
export const KNOWN_EXAMPLE_VALUES = new Set(['ffp_local_dev_password', 'Adm1n!Local2026']);

function load(): AppConfig {
  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }

  const env = parsed.data;

  // A development placeholder secret reaching production is a serious problem,
  // so refuse to boot rather than warn and continue.
  if (env.NODE_ENV === 'production') {
    /**
     * Every secret that ships with a working value in .env.example, not only the
     * two that carry a `change_me` marker.
     *
     * POSTGRES_PASSWORD and SEED_ADMIN_PASSWORD are real, functioning values in
     * the example file - a copy-and-fill deployment leaves them in place and
     * nothing complained, because the guard only looked for `change_me`. The
     * seeded admin password is the more serious of the two: it is a known
     * credential for an account that can approve budgets.
     */
    const candidates: ReadonlyArray<readonly [name: string, value: string]> = [
      ['JWT_SECRET', env.JWT_SECRET],
      ['AUDIT_HASH_SALT', env.AUDIT_HASH_SALT],
      ['SEED_ADMIN_PASSWORD', env.SEED_ADMIN_PASSWORD],
      ['POSTGRES_PASSWORD', process.env.POSTGRES_PASSWORD ?? ''],
    ];
    const insecure = candidates.filter(
      ([, value]) => value.includes('change_me') || KNOWN_EXAMPLE_VALUES.has(value),
    );

    if (insecure.length > 0) {
      throw new Error(
        `Refusing to start in production with values taken from .env.example: ` +
          `${insecure.map(([name]) => name).join(', ')}. Generate real values for each.`,
      );
    }
    if (env.PASSWORD_RESET_EXPOSE_TOKEN) {
      throw new Error(
        'PASSWORD_RESET_EXPOSE_TOKEN must not be set in production: it hands account takeover to anyone who knows an email address.',
      );
    }
  }

  return Object.freeze({
    ...env,
    LOG_PRETTY: env.LOG_PRETTY ?? env.NODE_ENV !== 'production',
    isProduction: env.NODE_ENV === 'production',
    isTest: env.NODE_ENV === 'test',
    corsOrigins: env.CORS_ORIGIN.split(',')
      .map((o) => o.trim())
      .filter(Boolean),
  });
}

export const config = load();
