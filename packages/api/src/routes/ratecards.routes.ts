/**
 * Rate cards: labour rates by location, channel and complexity, effective-dated.
 */
import type { FastifyInstance } from 'fastify';
import { AppError, queryBoolean, toMoneyString } from '@ffp/shared';
import {
  buildRateSchedule,
  rateCardDimensions,
  resolveRate,
  validateRateCard,
  type RateCardEntry,
} from '@ffp/engine';
import { z } from 'zod';
import { prisma } from '../db.js';
import { requireUser } from '../plugins/auth.plugin.js';
import { appendAuditEntry } from '../services/audit.service.js';

const rateString = z.string().regex(/^-?\d+(\.\d{1,6})?$/, 'Expected a decimal rate, e.g. "48.50"');
const dateish = z.string().refine((v) => !Number.isNaN(new Date(v).getTime()), 'Expected a date');

const entrySchema = z.object({
  labourCategory: z.string().min(1).max(120),
  location: z.string().max(80).nullish(),
  channel: z.string().max(80).nullish(),
  complexity: z.string().max(80).nullish(),
  rate: rateString,
  effectiveFrom: dateish,
  effectiveTo: dateish.nullish(),
});

/** Map database rows into the engine's shape. */
function toEngineEntries(
  rows: ReadonlyArray<{
    id: string;
    labourCategory: string;
    location: string | null;
    channel: string | null;
    complexity: string | null;
    rate: { toString(): string };
    effectiveFrom: Date;
    effectiveTo: Date | null;
  }>,
): RateCardEntry[] {
  return rows.map((row) => ({
    id: row.id,
    labourCategory: row.labourCategory,
    location: row.location,
    channel: row.channel,
    complexity: row.complexity,
    rate: row.rate.toString(),
    effectiveFrom: row.effectiveFrom,
    effectiveTo: row.effectiveTo,
  }));
}

async function loadCard(id: string) {
  const card = await prisma.rateCard.findUnique({
    where: { id },
    include: { entries: { orderBy: [{ labourCategory: 'asc' }, { effectiveFrom: 'asc' }] } },
  });
  if (!card) throw new AppError('NOT_FOUND', `Rate card '${id}' was not found.`);
  return card;
}

export async function registerRateCardRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', { onRequest: [app.requirePermission('pricing:read')] }, async (request) => {
    const query = z.object({ activeOnly: queryBoolean.default(true) }).parse(request.query);

    const cards = await prisma.rateCard.findMany({
      where: query.activeOnly ? { isActive: true } : {},
      orderBy: { code: 'asc' },
      include: { _count: { select: { entries: true } } },
    });

    return {
      data: cards.map((card) => ({
        id: card.id,
        code: card.code,
        name: card.name,
        description: card.description,
        currency: card.currency,
        isActive: card.isActive,
        entryCount: card._count.entries,
        updatedAt: card.updatedAt,
      })),
    };
  });

  app.get('/:id', { onRequest: [app.requirePermission('pricing:read')] }, async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const card = await loadCard(id);
    const entries = toEngineEntries(card.entries);

    return {
      data: {
        id: card.id,
        code: card.code,
        name: card.name,
        description: card.description,
        currency: card.currency,
        isActive: card.isActive,
        entries: card.entries.map((e) => ({
          id: e.id,
          labourCategory: e.labourCategory,
          location: e.location,
          channel: e.channel,
          complexity: e.complexity,
          rate: toMoneyString(e.rate.toString(), 6),
          effectiveFrom: e.effectiveFrom,
          effectiveTo: e.effectiveTo,
        })),
        dimensions: rateCardDimensions(entries),
        validation: validateRateCard(entries),
      },
    };
  });

  app.post('/', { onRequest: [app.requirePermission('pricing:write')] }, async (request, reply) => {
    const actor = requireUser(request);
    const input = z
      .object({
        code: z
          .string()
          .min(1)
          .max(32)
          .regex(/^[A-Z0-9_-]+$/, 'Use uppercase letters, digits, - or _'),
        name: z.string().min(1).max(160),
        description: z.string().max(2000).optional(),
        currency: z.string().length(3).default('USD'),
        entries: z.array(entrySchema).max(2000).default([]),
      })
      .parse(request.body);

    // Validate before writing: a card with overlapping effective ranges cannot
    // be resolved deterministically, so storing one only defers the failure to
    // whoever next prices against it.
    const validation = validateRateCard(input.entries as RateCardEntry[]);
    if (!validation.valid) {
      throw new AppError('VALIDATION_ERROR', 'This rate card is not internally consistent.', {
        details: validation.issues,
      });
    }

    const card = await prisma.rateCard.create({
      data: {
        code: input.code,
        name: input.name,
        description: input.description ?? null,
        currency: input.currency,
        createdById: actor.id,
        entries: {
          create: input.entries.map((e) => ({
            labourCategory: e.labourCategory,
            location: e.location ?? null,
            channel: e.channel ?? null,
            complexity: e.complexity ?? null,
            rate: e.rate,
            effectiveFrom: new Date(e.effectiveFrom),
            effectiveTo: e.effectiveTo ? new Date(e.effectiveTo) : null,
          })),
        },
      },
      select: { id: true, code: true, name: true },
    });

    await appendAuditEntry({
      actorId: actor.id,
      actorEmail: actor.email,
      action: 'CREATE',
      entityType: 'RateCard',
      entityId: card.id,
      summary: `Created rate card ${card.code} - ${card.name} with ${input.entries.length} entr(ies)`,
      changes: { code: card.code, entryCount: input.entries.length },
    });

    return reply.status(201).send({ data: card });
  });

  /** Replace a card's entries wholesale. Validated the same way as creation. */
  app.put(
    '/:id/entries',
    { onRequest: [app.requirePermission('pricing:write')] },
    async (request) => {
      const actor = requireUser(request);
      const { id } = z.object({ id: z.string() }).parse(request.params);
      const { entries } = z.object({ entries: z.array(entrySchema).max(2000) }).parse(request.body);

      const card = await loadCard(id);

      const validation = validateRateCard(entries as RateCardEntry[]);
      if (!validation.valid) {
        throw new AppError('VALIDATION_ERROR', 'This rate card is not internally consistent.', {
          details: validation.issues,
        });
      }

      await prisma.$transaction(async (tx) => {
        await tx.rateCardEntry.deleteMany({ where: { rateCardId: id } });
        if (entries.length > 0) {
          await tx.rateCardEntry.createMany({
            data: entries.map((e) => ({
              rateCardId: id,
              labourCategory: e.labourCategory,
              location: e.location ?? null,
              channel: e.channel ?? null,
              complexity: e.complexity ?? null,
              rate: e.rate,
              effectiveFrom: new Date(e.effectiveFrom),
              effectiveTo: e.effectiveTo ? new Date(e.effectiveTo) : null,
            })),
          });
        }

        await appendAuditEntry(
          {
            actorId: actor.id,
            actorEmail: actor.email,
            action: 'UPDATE',
            entityType: 'RateCard',
            entityId: id,
            summary: `Replaced the entries on rate card ${card.code}: ${card.entries.length} -> ${entries.length}`,
            changes: { from: card.entries.length, to: entries.length },
          },
          tx,
        );
      });

      return { data: { id, entryCount: entries.length } };
    },
  );

  /**
   * Resolve a single rate, with the reasoning.
   *
   * The explanation matters as much as the number: a quoted price has to be
   * defensible, and "the card said so" is not defensible unless you can say
   * which rule matched and what it fell back on.
   */
  app.get(
    '/:id/resolve',
    { onRequest: [app.requirePermission('pricing:read')] },
    async (request) => {
      const { id } = z.object({ id: z.string() }).parse(request.params);
      const query = z
        .object({
          labourCategory: z.string().min(1),
          location: z.string().optional(),
          channel: z.string().optional(),
          complexity: z.string().optional(),
          asOf: dateish.optional(),
        })
        .parse(request.query);

      const card = await loadCard(id);
      const resolved = resolveRate(
        toEngineEntries(card.entries),
        {
          labourCategory: query.labourCategory,
          location: query.location,
          channel: query.channel,
          complexity: query.complexity,
        },
        query.asOf ?? new Date(),
      );

      return {
        data: {
          rate: resolved.rate,
          currency: card.currency,
          specificity: resolved.specificity,
          fellBackOn: resolved.fellBackOn,
          explanation: resolved.explanation,
          effectiveFrom: resolved.effectiveFrom,
          effectiveTo: resolved.effectiveTo,
          matchedEntryId: resolved.entry.id ?? null,
        },
      };
    },
  );

  /**
   * A rate per contract year, honouring effective-dated changes mid-term.
   *
   * The output feeds straight into a pricing model's `ratesByYear`, which is the
   * point: a five-year contract crossing an April rate change should pick both
   * rates up without anyone remembering to.
   */
  app.post(
    '/:id/schedule',
    { onRequest: [app.requirePermission('pricing:read')] },
    async (request) => {
      const { id } = z.object({ id: z.string() }).parse(request.params);
      const input = z
        .object({
          labourCategory: z.string().min(1),
          location: z.string().optional(),
          channel: z.string().optional(),
          complexity: z.string().optional(),
          startDate: dateish,
          years: z.number().int().min(1).max(20),
          escalationBeyondCard: rateString.optional(),
        })
        .parse(request.body);

      const card = await loadCard(id);
      const schedule = buildRateSchedule(
        toEngineEntries(card.entries),
        {
          labourCategory: input.labourCategory,
          location: input.location,
          channel: input.channel,
          complexity: input.complexity,
        },
        {
          startDate: input.startDate,
          years: input.years,
          escalationBeyondCard: input.escalationBeyondCard,
        },
      );

      return { data: { ...schedule, currency: card.currency } };
    },
  );

  /**
   * Price a set of labour lines straight from the card.
   *
   * Resolves a rate schedule per line and returns them ready to drop into a
   * pricing model, so the caller never transcribes a rate by hand.
   */
  app.post(
    '/:id/price-labour',
    { onRequest: [app.requirePermission('pricing:read')] },
    async (request) => {
      const { id } = z.object({ id: z.string() }).parse(request.params);
      const input = z
        .object({
          startDate: dateish,
          years: z.number().int().min(1).max(20),
          escalationBeyondCard: rateString.optional(),
          lines: z
            .array(
              z.object({
                labourCategory: z.string().min(1).max(120),
                location: z.string().optional(),
                channel: z.string().optional(),
                complexity: z.string().optional(),
                hoursByYear: z.array(z.number().min(0).max(1_000_000)).min(1).max(20),
              }),
            )
            .min(1)
            .max(500),
        })
        .parse(request.body);

      const card = await loadCard(id);
      const entries = toEngineEntries(card.entries);
      const warnings: string[] = [];

      const lines = input.lines.map((line) => {
        const schedule = buildRateSchedule(
          entries,
          {
            labourCategory: line.labourCategory,
            location: line.location,
            channel: line.channel,
            complexity: line.complexity,
          },
          {
            startDate: input.startDate,
            years: input.years,
            escalationBeyondCard: input.escalationBeyondCard,
          },
        );
        warnings.push(...schedule.warnings);

        return {
          labourCategory: line.labourCategory,
          location: line.location ?? null,
          hoursByYear: line.hoursByYear,
          // baseRate is required by the pricing model's shape but ignored when
          // a schedule is present; year 1 keeps it meaningful if anything reads it.
          baseRate: schedule.ratesByYear[0] ?? '0',
          ratesByYear: schedule.ratesByYear,
          rateExplanations: schedule.entries.map((e) => ({
            year: e.year,
            rate: e.rate,
            source: e.source,
            explanation: e.explanation,
          })),
        };
      });

      return {
        data: {
          currency: card.currency,
          labour: lines,
          warnings: [...new Set(warnings)],
          note: 'Drop `labour` into POST /pricing/calculate. Rates already reflect effective-dated card changes, so leave escalationRate unset on these lines.',
        },
      };
    },
  );
}
