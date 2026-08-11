/**
 * Background timers: notification dispatch and the deadline scan.
 *
 * Deliberately `setInterval` in-process rather than a job queue. This platform is
 * a single API process serving one finance function; adding Redis and a worker
 * fleet to send a few hundred emails a month would be infrastructure to maintain
 * for no benefit. Both jobs are idempotent - the dispatcher only touches PENDING
 * rows, and the scanner dedupes by day - so a second process running the same
 * timers duplicates work but corrupts nothing. If this ever needs to scale, that
 * property is what makes moving to a queue a small change.
 *
 * Both timers are `unref`ed so they never hold the process open during shutdown,
 * and every run is wrapped: a failing scan must not take the API down with it.
 */
import type { FastifyInstance } from 'fastify';
import { config } from './config.js';
import { emitAnchor, fileSink, logSink } from './services/audit-anchor.service.js';
import { purgeExpiredTokens } from './services/auth.service.js';
import { scanDeadlines } from './services/deadline.service.js';
import { purgeExpiredResetTokens } from './services/password-reset.service.js';
import {
  createLogTransport,
  dispatchPending,
  registerTransport,
  resetTransports,
} from './services/notification.service.js';

export interface StartedWorkers {
  stop(): void;
}

export function configureTransports(app: FastifyInstance): void {
  resetTransports();

  // IN_APP is always available: the row in the inbox is the delivery.
  registerTransport({
    channel: 'IN_APP',
    async send() {
      /* the row is the message */
    },
  });

  if (config.NOTIFICATION_TRANSPORT === 'log') {
    registerTransport(createLogTransport((line) => app.log.info(line), 'EMAIL'));
  }
  // 'none' registers no EMAIL transport. Those rows retry, then land in FAILED
  // with "No transport registered" - visible, rather than silently discarded.
}

export function startWorkers(app: FastifyInstance): StartedWorkers {
  const timers: NodeJS.Timeout[] = [];

  const every = (seconds: number, name: string, run: () => Promise<unknown>): void => {
    if (seconds <= 0) {
      app.log.info({ job: name }, 'background job disabled by configuration');
      return;
    }
    const timer = setInterval(() => {
      void run().catch((error) => {
        app.log.error({ err: error, job: name }, 'background job failed');
      });
    }, seconds * 1000);
    timer.unref();
    timers.push(timer);
    app.log.info({ job: name, everySeconds: seconds }, 'background job scheduled');
  };

  every(config.NOTIFICATION_DISPATCH_SECONDS, 'notification-dispatch', async () => {
    const result = await dispatchPending();
    if (result.sent || result.failed || result.suppressed) {
      app.log.info(result, 'notifications dispatched');
    }
  });

  every(config.DEADLINE_SCAN_SECONDS, 'deadline-scan', async () => {
    const result = await scanDeadlines({ appUrl: config.APP_URL });
    if (result.queued > 0) app.log.info(result, 'deadline reminders queued');
  });

  /**
   * Emit the audit chain head somewhere the database cannot reach.
   *
   * Logged at `warn` rather than `info` deliberately: this is the record that
   * makes tail truncation detectable, and it needs to survive a log level set
   * to filter routine chatter. An anchor that was never retained is an anchor
   * that never existed.
   */
  every(config.AUDIT_ANCHOR_SECONDS, 'audit-anchor', async () => {
    const sinks = [
      logSink((anchor) => app.log.warn({ auditAnchor: anchor }, 'audit chain anchor')),
      ...(config.AUDIT_ANCHOR_FILE ? [fileSink(config.AUDIT_ANCHOR_FILE)] : []),
    ];

    const result = await emitAnchor(sinks);
    if (result.failed.length > 0) {
      app.log.error({ failed: result.failed }, 'audit anchor sink(s) failed');
    }
  });

  /**
   * Housekeeping for expired credentials.
   *
   * `purgeExpiredTokens` and `purgeExpiredResetTokens` were both written, both
   * exported, and never called by anything - so refresh tokens accumulated for
   * the life of the deployment. Every sign-in creates one.
   *
   * This is the only deletion the platform performs. It is safe precisely
   * because these are not financial records: nothing references them, no audit
   * entry depends on them, and an expired token grants nothing.
   */
  every(config.TOKEN_PURGE_SECONDS, 'token-purge', async () => {
    const [refresh, reset] = await Promise.all([purgeExpiredTokens(), purgeExpiredResetTokens()]);
    if (refresh > 0 || reset > 0) {
      app.log.info({ refresh, reset }, 'expired tokens purged');
    }
  });

  return {
    stop() {
      for (const timer of timers) clearInterval(timer);
      timers.length = 0;
    },
  };
}
