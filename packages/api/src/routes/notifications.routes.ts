/**
 * Notification inbox, preferences and the operator-facing dispatch controls.
 *
 * Everything here is scoped to the calling user. There is deliberately no
 * "read anyone's inbox" endpoint: notification bodies quote budget totals, and
 * an administrator who needs those has the budget endpoints and the audit trail,
 * both of which record that they looked.
 */
import type { FastifyInstance } from 'fastify';
import {
  AppError,
  NOTIFICATION_MUTABLE,
  NOTIFICATION_TYPES,
  NOTIFICATION_TYPE_LABELS,
  queryBoolean,
  type NotificationType,
} from '@ffp/shared';
import { z } from 'zod';
import { config } from '../config.js';
import { prisma } from '../db.js';
import { requireUser } from '../plugins/auth.plugin.js';
import { dispatchPending, setPreference } from '../services/notification.service.js';
import { scanDeadlines } from '../services/deadline.service.js';

const notificationTypeSchema = z.enum(NOTIFICATION_TYPES);

export async function registerNotificationRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', { onRequest: [app.authenticate] }, async (request) => {
    const user = requireUser(request);
    const query = z
      .object({
        unreadOnly: queryBoolean.optional().default(false),
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(100).default(25),
      })
      .parse(request.query);

    const where = {
      userId: user.id,
      // SUPPRESSED rows exist for support, not for the person who muted them.
      status: { not: 'SUPPRESSED' as const },
      ...(query.unreadOnly ? { readAt: null } : {}),
    };

    const [rows, total, unread] = await Promise.all([
      prisma.notification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        select: {
          id: true,
          type: true,
          channel: true,
          status: true,
          subject: true,
          body: true,
          entityType: true,
          entityId: true,
          sentAt: true,
          readAt: true,
          createdAt: true,
        },
      }),
      prisma.notification.count({ where }),
      prisma.notification.count({
        where: { userId: user.id, readAt: null, status: { not: 'SUPPRESSED' } },
      }),
    ]);

    return {
      data: rows,
      unread,
      pagination: { page: query.page, pageSize: query.pageSize, total },
    };
  });

  app.post('/:id/read', { onRequest: [app.authenticate] }, async (request) => {
    const user = requireUser(request);
    const { id } = z.object({ id: z.string().min(1) }).parse(request.params);

    // updateMany, scoped by userId, so a guessed id touches nothing and the
    // response cannot distinguish "not yours" from "does not exist".
    const result = await prisma.notification.updateMany({
      where: { id, userId: user.id, readAt: null },
      data: { readAt: new Date() },
    });

    return { success: true, updated: result.count };
  });

  app.post('/read-all', { onRequest: [app.authenticate] }, async (request) => {
    const user = requireUser(request);
    const result = await prisma.notification.updateMany({
      where: { userId: user.id, readAt: null },
      data: { readAt: new Date() },
    });
    return { success: true, updated: result.count };
  });

  app.get('/preferences', { onRequest: [app.authenticate] }, async (request) => {
    const user = requireUser(request);
    const rows = await prisma.notificationPreference.findMany({ where: { userId: user.id } });
    const muted = new Set(rows.filter((r) => r.muted).map((r) => r.type as NotificationType));

    return {
      data: NOTIFICATION_TYPES.map((type) => ({
        type,
        label: NOTIFICATION_TYPE_LABELS[type],
        mutable: NOTIFICATION_MUTABLE[type],
        muted: muted.has(type),
      })),
    };
  });

  app.put('/preferences', { onRequest: [app.authenticate] }, async (request) => {
    const user = requireUser(request);
    const { type, muted } = z
      .object({ type: notificationTypeSchema, muted: z.boolean() })
      .parse(request.body);

    if (muted && !NOTIFICATION_MUTABLE[type]) {
      throw new AppError(
        'VALIDATION_ERROR',
        `${NOTIFICATION_TYPE_LABELS[type]} cannot be muted: it is information you need regardless of preference.`,
      );
    }

    await setPreference(user.id, type, muted);
    return { success: true, type, muted };
  });

  /**
   * Run the dispatcher now.
   *
   * The background timer already does this; the endpoint exists so an operator
   * can flush the queue after fixing a transport without waiting out the
   * interval, and so the smoke test can assert delivery deterministically.
   */
  app.post('/dispatch', { onRequest: [app.requirePermission('settings:manage')] }, async () => {
    const result = await dispatchPending();
    return { ...result, transport: config.NOTIFICATION_TRANSPORT };
  });

  app.post(
    '/scan-deadlines',
    { onRequest: [app.requirePermission('settings:manage')] },
    async () => {
      const result = await scanDeadlines({ appUrl: config.APP_URL });
      return result;
    },
  );
}
