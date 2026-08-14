/**
 * Is everything that was built actually reachable, and is it exercised?
 *
 * One defect shape has been found repeatedly in this codebase, always by hand,
 * always months later, always by someone wondering whether a thing worked:
 *
 *   - `pricing:approve` and `report:publish_leadership` sat in the permission
 *     matrix and in the user manual while guarding no route at all
 *   - `budget:delete` and `actuals:read` did the same and were removed
 *   - the leadership pack, the scenario comparison and the driver build-up all
 *     worked over HTTP with nothing in the interface leading to them
 *   - the `drivers` table was seeded and read by no route
 *   - `pricing_models.approvedAt` was never written while the manual advertised
 *     the capability it represented
 *   - `purgeExpiredTokens` was exported and called by nothing, so every sign-in
 *     leaked a row for the life of the deployment
 *
 * Every one passed every test. Tests answer "does this work when called"; none
 * asks "does anything call it". That is what this asks.
 *
 * **Calibrated before being trusted.** The first draft reported 22 dead exports
 * and one unwritten table, and almost all of it was noise: `shared/index.ts` is
 * `export *`, so every function there is public API by construction, and
 * `BudgetLinePeriod` is written through a nested `periods: { create }` whose
 * relation name does not match the model name. A check that cries wolf gets
 * switched off, so those rules were dropped rather than shipped loud.
 *
 * What survives is what produced real findings. Exceptions are declared with a
 * reason, and the list doubles as the register of deliberate decisions.
 *
 *   node scripts/check-reachability.mjs
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const IGNORED = new Set(['node_modules', 'dist', 'coverage', '.git', 'build', '.turbo', '.venv']);

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (IGNORED.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const read = (file) => readFileSync(file, 'utf8');
const failures = [];

function fail(title, why, fix, offenders) {
  if (offenders.length > 0) failures.push({ title, why, fix, offenders });
}

// ---------------------------------------------------------------------------
// 1. Every permission guards something
// ---------------------------------------------------------------------------

/**
 * Enforced by role seniority rather than by permission name.
 *
 * `TRANSITION_MIN_ROLE` maps each budget status to the minimum role that may
 * move a budget into it, and `budget.service.ts` checks that instead of calling
 * `can()`. These permissions are real and enforced; a scan for the string will
 * never find them. Reported as gaps on the first run of this check - three false
 * positives out of six.
 */
const PERMISSION_EXCEPTIONS = new Map([
  ['budget:submit', 'Enforced through TRANSITION_MIN_ROLE seniority in budget.service.ts.'],
  ['budget:approve', 'Enforced through TRANSITION_MIN_ROLE seniority in budget.service.ts.'],
  ['budget:lock', 'Enforced through TRANSITION_MIN_ROLE seniority in budget.service.ts.'],
]);

{
  const rbac = read(join(root, 'packages/shared/src/rbac.ts'));
  const declaration = rbac.slice(
    rbac.indexOf('export const PERMISSIONS'),
    rbac.indexOf('] as const;'),
  );
  const permissions = [
    ...new Set([...declaration.matchAll(/'([a-z_]+:[a-z_]+)'/g)].map((m) => m[1])),
  ];

  const apiText = walk(join(root, 'packages/api/src'))
    .filter((f) => /\.ts$/.test(f) && !/\.test\.ts$/.test(f))
    .map(read)
    .join('\n');

  fail(
    'A permission guards nothing',
    'It is published in the user manual as a capability of a role and no route requires it. The manual’s matrix check compares two matrices and never asks whether a permission is reached.',
    'Add the route that requires it, remove the permission, or add it to PERMISSION_EXCEPTIONS with the mechanism that enforces it.',
    permissions.filter((p) => !PERMISSION_EXCEPTIONS.has(p) && !apiText.includes(`'${p}'`)),
  );
}

// ---------------------------------------------------------------------------
// 2. Every route is exercised by a test or an end-to-end suite
// ---------------------------------------------------------------------------

/**
 * A ratchet, not a target - the same shape as the API coverage gate.
 *
 * 23 of 109 routes had no mention in any test or suite when this check was
 * written. All 109 are now exercised, so the budget is **zero** - which is the
 * strongest form this can take: a route added without a test fails the build,
 * immediately, with no allowance to spend.
 *
 * It fails in both directions on purpose. If the number ever drops below the
 * budget again - because a route was deleted, say - that fails too, as the
 * reminder to lower it. A ratchet that is never tightened stops ratcheting.
 *
 * "Mentioned in a test or suite" is a deliberately weak bar - it proves the
 * route is reachable and someone has called it, not that its behaviour is
 * right. Behaviour is what the route tests and journeys are for. This is the
 * floor beneath them, and a floor at zero is still only a floor.
 */
const UNCOVERED_ROUTE_BUDGET = 0;

{
  const routes = [];
  for (const file of walk(join(root, 'packages/api/src/routes'))) {
    if (!/\.routes\.ts$/.test(file)) continue;
    const text = read(file);
    for (const [, method, path] of text.matchAll(
      /app\.(get|post|put|patch|delete)\(\s*'([^']+)'/g,
    )) {
      routes.push({ file: relative(root, file), method: method.toUpperCase(), path });
    }
  }

  const exercised = [
    ...walk(join(root, 'packages/api/src')).filter((f) => /\.test\.ts$/.test(f)),
    ...walk(join(root, 'scripts')).filter((f) => /\.(mjs|ps1)$/.test(f)),
  ]
    .map(read)
    .join('\n');

  const uncovered = routes.filter(({ path }) => {
    if (path === '/') return false;
    const literal = path.includes(':') ? path.slice(0, path.indexOf(':')) : path;
    return literal.length > 2 && !exercised.includes(literal);
  });

  console.log(
    `  routes: ${routes.length} registered, ${routes.length - uncovered.length} exercised, ${uncovered.length} not (budget ${UNCOVERED_ROUTE_BUDGET})`,
  );

  if (uncovered.length > UNCOVERED_ROUTE_BUDGET) {
    fail(
      'A route is not exercised by any test or suite',
      `${uncovered.length} routes have no mention in a route test, an e2e suite or a browser journey - above the budget of ${UNCOVERED_ROUTE_BUDGET}. An untested route is not known to be callable at all.`,
      'Add a test that calls it, or an e2e suite that walks it.',
      uncovered.map((r) => `${r.method} ${r.path}  (${r.file})`),
    );
  } else if (uncovered.length < UNCOVERED_ROUTE_BUDGET) {
    fail(
      'The uncovered-route budget is stale',
      `Only ${uncovered.length} routes are now uncovered, below the recorded budget of ${UNCOVERED_ROUTE_BUDGET}. A ratchet that is never tightened stops ratcheting.`,
      `Lower UNCOVERED_ROUTE_BUDGET to ${uncovered.length} in this file.`,
      [`${uncovered.length} < ${UNCOVERED_ROUTE_BUDGET}`],
    );
  }
}

// ---------------------------------------------------------------------------
// 3. Every table has something that writes to it
// ---------------------------------------------------------------------------

/**
 * A model nothing writes is either an unfinished feature or a decision nobody
 * recorded. `pricing_models.approvedAt` was the first kind; `Scenario` is the
 * second.
 *
 * Relation names are matched as well as client properties, because a nested
 * write goes through the relation field - `BudgetLinePeriod` is written as
 * `periods: { create }`, which names neither the model nor its client property.
 * That was a false positive on the first run.
 */
const MODEL_EXCEPTIONS = new Map([
  [
    'Scenario',
    'Deliberately unwritten: scenario comparison is a calculator. The decision and its trigger are on the model in schema.prisma.',
  ],
]);

{
  const schema = read(join(root, 'packages/api/prisma/schema.prisma'));
  const models = [...schema.matchAll(/^model (\w+) \{/gm)].map((m) => m[1]);

  const apiText = walk(join(root, 'packages/api/src'))
    .filter((f) => /\.ts$/.test(f) && !/\.test\.ts$/.test(f))
    .map(read)
    .join('\n');

  const unwritten = models.filter((model) => {
    if (MODEL_EXCEPTIONS.has(model)) return false;
    const client = model.charAt(0).toLowerCase() + model.slice(1);
    const direct = new RegExp(
      `\\b(prisma|tx|client)\\.${client}\\.(create|createMany|upsert|update|updateMany|delete|deleteMany)`,
    );
    if (direct.test(apiText)) return false;

    // Nested writes name the relation field, which need not resemble the model.
    // Resolve the relation names pointing at this model from the schema itself
    // rather than guessing from its name.
    const relations = new Set();
    for (const [, field] of schema.matchAll(new RegExp(`^\\s+(\\w+)\\s+${model}\\[\\]`, 'gm'))) {
      relations.add(field);
    }
    for (const [, field] of schema.matchAll(new RegExp(`^\\s+(\\w+)\\s+${model}\\??\\s`, 'gm'))) {
      relations.add(field);
    }
    for (const relation of relations) {
      if (
        new RegExp(`${relation}:\\s*\\{\\s*(create|createMany|connectOrCreate|upsert)`).test(
          apiText,
        )
      ) {
        return false;
      }
    }
    return true;
  });

  fail(
    'A table is never written',
    'Either the feature was never finished, or it is a deliberate decision nobody recorded.',
    'Write to it, drop it, or add it to MODEL_EXCEPTIONS with the decision and the trigger that would change it.',
    unwritten,
  );
}

// ---------------------------------------------------------------------------

if (failures.length === 0) {
  console.log('reachability: OK');
  process.exit(0);
}

for (const failure of failures) {
  console.error(`\n  FAIL  ${failure.title}`);
  console.error(`        ${failure.why}`);
  console.error(`        Fix: ${failure.fix}`);
  for (const offender of failure.offenders) console.error(`          - ${offender}`);
}
console.error(`\n${failures.length} reachability rule(s) violated.\n`);
process.exit(1);
