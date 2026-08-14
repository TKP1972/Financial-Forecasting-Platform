/**
 * What this platform is for, who does what in it, and what it deliberately
 * does not do.
 *
 * It exists because every other screen assumes you already know. A person
 * opening Variance for the first time can see that the arithmetic is right
 * without having any idea why they would run it, or what happens next, or
 * which of the six roles they are looking at the product through. That is a
 * fair thing to be confused by: the order matters more than any single screen.
 *
 * Two decisions worth defending:
 *
 *   - It is **generated from the same constants the product enforces**. The
 *     approval limits and the permission counts below are read from
 *     `@ffp/shared`, not typed in. An "about" page that drifts from the system
 *     it describes is worse than no page, and this one cannot: change a limit
 *     and this screen changes with it.
 *   - It states the **limits** out loud. An institution evaluating a financial
 *     system will find them anyway, and finding them written down by the
 *     vendor is a different conversation from finding them uncovered.
 */
import { DEFAULT_APPROVAL_LIMITS, ROLE_LABELS, can, permissionsFor, type Role } from '@ffp/shared';
import { Link } from 'react-router-dom';
import { Card, InlineNote, PageHeader } from '@/components/ui';
import { integer, money0 } from '@/lib/format';
import { useAuthStore } from '@/store/auth';

/** The stages of a year, in the order they actually happen. */
const STAGES: Array<{ step: string; title: string; who: string; body: string; to: string }> = [
  {
    step: '1',
    title: 'Open the cycle',
    who: 'Finance Manager or CFO',
    body: 'A fiscal year (or a rolling horizon) is opened with its periods, its currency and its calendar. Every budget and every actual afterwards hangs off it, and the period key is what lets a plan and a payment be compared at all.',
    to: '/cycles',
  },
  {
    step: '2',
    title: 'Build and submit the budget',
    who: 'Financial Analyst, then the Budget Owner',
    body: 'Lines are entered against the chart of accounts and phased across the periods. The person who builds it submits it; they cannot approve it. Amounts above a role’s delegated limit escalate to someone senior enough to carry them.',
    to: '/budgets',
  },
  {
    step: '3',
    title: 'Forecast what the year will cost',
    who: 'Financial Analyst',
    body: 'A forecast is fitted to history and backtested against periods it was not shown, so the claim that it beats a naive guess is measured rather than asserted. Risk is quantified by simulation, from an explicit seed, so a contingency figure quoted to a board can be re-derived a year later.',
    to: '/forecasting',
  },
  {
    step: '4',
    title: 'Price the work that wins it',
    who: 'Analyst prices, a second person approves',
    body: 'Bid models carry cost, price and margin. Whoever built the model cannot sign it off, and the profit position is hidden from anyone without the permission to see it — including in the data behind the screen, not merely on it.',
    to: '/pricing',
  },
  {
    step: '5',
    title: 'Record what was actually spent',
    who: 'Finance Manager',
    body: 'Actuals are imported period by period and matched to the plan on the period key. Re-sending a period corrects it rather than doubling it, because a finance system re-states as invoices settle.',
    to: '/variance',
  },
  {
    step: '6',
    title: 'Explain the difference, then answer for it',
    who: 'Everyone, at the review',
    body: 'Variance says how far off the plan you are; the decomposition says whether that was volume or price, which are different problems with different owners. The leadership pack is the version that leaves the building, and issuing it takes a snapshot of what it said on the day.',
    to: '/reports',
  },
];

/** What each role is for, in the words someone would use to introduce them. */
const ROLE_NOTES: Record<Role, string> = {
  VIEWER: 'Reads the position. Changes nothing, and cannot see the margin on a bid.',
  ANALYST: 'Builds budgets, runs forecasts and prices bids. Cannot submit or approve.',
  BUDGET_OWNER: 'Owns a unit’s numbers, submits them for approval, and can see margin.',
  FINANCE_MANAGER: 'Runs the cycle, imports actuals, and is the first role that can approve.',
  CFO: 'Approves without limit, locks an approved budget, and verifies the audit chain.',
  ADMIN: 'Runs the platform: users, settings, reference data, the audit chain. Transacts nothing.',
};

/**
 * Whether a role can approve at all, taken from the permission the product
 * requires rather than from the limits table.
 *
 * They are not the same question, and conflating them would misrepresent the
 * system: `DEFAULT_APPROVAL_LIMITS` names a figure for every role, but a limit
 * is only ever consulted at an approval, and an approval requires
 * `budget:approve`. The System Administrator is the case that makes the
 * distinction visible - it outranks the CFO and holds no approval authority
 * whatever, which is the point of the role.
 */
const canApprove = (role: Role) => can(role, 'budget:approve');

const ROLE_ORDER: Role[] = ['VIEWER', 'ANALYST', 'BUDGET_OWNER', 'FINANCE_MANAGER', 'CFO', 'ADMIN'];

export default function About() {
  const user = useAuthStore((state) => state.user);

  return (
    <>
      <PageHeader
        title="About this platform"
        description="What it is for, the order things happen in, and the limits it does not pretend to exceed."
      />

      <Card className="mb-4" title="What it is for">
        <p className="text-xs leading-relaxed text-slate-700 dark:text-slate-300">
          An operator commits to what a year will cost before the year starts, spends against that
          commitment, and then has to explain the difference to people who were not in the room.
          This platform is where those three things live together: the plan, the money that actually
          moved, and the arithmetic that reconciles them.
        </p>
        <p className="mt-3 text-xs leading-relaxed text-slate-700 dark:text-slate-300">
          The reason it is not a spreadsheet is the third part. A figure in a board pack is only
          worth as much as the answer to{' '}
          <em>
            who approved this, on what evidence, and can they show it was not changed afterwards
          </em>
          . Every approval here is recorded against a named person, every amendment leaves the
          previous version standing, and nothing is deleted — a correction is a new fact, not the
          removal of an old one.
        </p>
      </Card>

      <Card
        className="mb-4"
        title="How a year runs"
        subtitle="Six stages in the order they happen. Each links to the screen that does it."
      >
        <ol className="space-y-3">
          {STAGES.map((stage) => (
            <li key={stage.step} className="flex gap-3">
              <span
                aria-hidden="true"
                className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent-100 text-2xs font-semibold text-accent-800 dark:bg-accent-900/60 dark:text-accent-200"
              >
                {stage.step}
              </span>
              <div className="min-w-0">
                <p className="text-xs font-semibold text-slate-800 dark:text-slate-100">
                  <Link
                    to={stage.to}
                    className="text-accent-700 underline underline-offset-2 dark:text-accent-300"
                  >
                    {stage.title}
                  </Link>
                  <span className="ml-2 font-normal text-slate-500 dark:text-slate-400">
                    {stage.who}
                  </span>
                </p>
                <p className="mt-1 text-xs leading-relaxed text-slate-600 dark:text-slate-400">
                  {stage.body}
                </p>
              </div>
            </li>
          ))}
        </ol>
      </Card>

      <Card
        className="mb-4"
        title="Who does what"
        subtitle="Six roles. The limit is the largest amount that role can approve on its own."
      >
        <div className="overflow-x-auto">
          <table className="data-table">
            <caption>
              Roles, their part in the year, and their delegated approval authority. Read from the
              same tables the API enforces, so it cannot drift from what actually happens. A role
              that cannot reach the approval transition has no approval authority at all, whatever a
              limit might say.
            </caption>
            <thead>
              <tr>
                <th scope="col">Role</th>
                <th scope="col">What they are for</th>
                <th scope="col" className="num">
                  Approves up to
                </th>
                <th scope="col" className="num">
                  Permissions
                </th>
              </tr>
            </thead>
            <tbody>
              {ROLE_ORDER.map((role) => {
                const limit = DEFAULT_APPROVAL_LIMITS[role];
                const isMine = user?.role === role;
                return (
                  <tr
                    key={role}
                    className={isMine ? 'bg-accent-50/60 dark:bg-accent-900/20' : undefined}
                  >
                    <td className="font-medium text-slate-800 dark:text-slate-100">
                      {ROLE_LABELS[role]}
                      {isMine ? (
                        <span className="ml-2 pill bg-accent-100 text-accent-800 dark:bg-accent-900/50 dark:text-accent-200">
                          You
                        </span>
                      ) : null}
                    </td>
                    <td className="text-slate-600 dark:text-slate-400">{ROLE_NOTES[role]}</td>
                    <td className="num">
                      {!canApprove(role) ? (
                        <span className="text-slate-600 dark:text-slate-400">Not an approver</span>
                      ) : limit === null ? (
                        'No limit'
                      ) : (
                        money0(limit)
                      )}
                    </td>
                    <td className="num">{integer(permissionsFor(role).length)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      <Card
        className="mb-4"
        title="What makes a figure defensible"
        subtitle="Five controls. They are the reason the numbers are worth quoting."
      >
        <dl className="grid gap-4 text-xs sm:grid-cols-2">
          <div>
            <dt className="font-semibold text-slate-800 dark:text-slate-100">
              Nobody approves their own work
            </dt>
            <dd className="mt-1 leading-relaxed text-slate-600 dark:text-slate-400">
              The person who prepared a budget or priced a bid cannot sign it off, and no seniority
              buys an exemption. The System Administrator is not an exception to the rule but a step
              further from it: it holds no financial authority at all, so administering the platform
              and transacting in it are different jobs held by different people.
            </dd>
          </div>
          <div>
            <dt className="font-semibold text-slate-800 dark:text-slate-100">
              Authority has a ceiling
            </dt>
            <dd className="mt-1 leading-relaxed text-slate-600 dark:text-slate-400">
              An approval above a role&rsquo;s delegated limit is refused, not warned about. Larger
              commitments escalate to someone who can carry them.
            </dd>
          </div>
          <div>
            <dt className="font-semibold text-slate-800 dark:text-slate-100">Nothing is deleted</dt>
            <dd className="mt-1 leading-relaxed text-slate-600 dark:text-slate-400">
              A budget is amended and the prior version stands. The history of what was believed,
              and when, survives the correction.
            </dd>
          </div>
          <div>
            <dt className="font-semibold text-slate-800 dark:text-slate-100">
              The audit trail is chained
            </dt>
            <dd className="mt-1 leading-relaxed text-slate-600 dark:text-slate-400">
              Each entry is hashed over the one before it, so a row altered after the fact breaks
              every hash that follows. Governance verifies the chain on demand.
            </dd>
          </div>
          <div>
            <dt className="font-semibold text-slate-800 dark:text-slate-100">
              A published number can be re-derived
            </dt>
            <dd className="mt-1 leading-relaxed text-slate-600 dark:text-slate-400">
              Simulations take an explicit seed rather than chance. A contingency figure quoted to a
              board reproduces exactly, a year later, from the same inputs.
            </dd>
          </div>
          <div>
            <dt className="font-semibold text-slate-800 dark:text-slate-100">
              Money is never a rounding error
            </dt>
            <dd className="mt-1 leading-relaxed text-slate-600 dark:text-slate-400">
              Amounts are held as exact decimals, never as floating point, and a total split across
              periods sums back to the amount it came from.
            </dd>
          </div>
        </dl>
      </Card>

      <Card title="What it does not do" bodyClassName="p-4">
        <InlineNote>
          Said plainly, because an evaluator finds these anyway and it is better they read them
          here.
        </InlineNote>
        <ul className="mt-3 space-y-2 text-xs leading-relaxed text-slate-600 dark:text-slate-400">
          <li>
            <strong className="text-slate-800 dark:text-slate-100">
              It is not a general ledger.
            </strong>{' '}
            It plans and explains; it does not post journals or close books. Actuals are imported
            from the system that does.
          </li>
          <li>
            <strong className="text-slate-800 dark:text-slate-100">
              It does not model cash, tax or the balance sheet.
            </strong>{' '}
            The scope is budget, forecast, price and variance. A three-statement model is a
            different product, and pretending otherwise would be the expensive kind of mistake.
          </li>
          <li>
            <strong className="text-slate-800 dark:text-slate-100">
              A forecast is a measured estimate, not a prediction.
            </strong>{' '}
            Accuracy is reported against periods the model never saw, so you can judge how much to
            trust it. That is the honest version, and it is sometimes not very much.
          </li>
          <li>
            <strong className="text-slate-800 dark:text-slate-100">
              The audit chain has a stated threat model.
            </strong>{' '}
            It makes tampering detectable, not impossible. Someone who can reach the database host
            can likely also recompute the hashes; anchoring the chain head outside the database is
            what narrows that. The limits are documented rather than glossed over.
          </li>
        </ul>
      </Card>
    </>
  );
}
