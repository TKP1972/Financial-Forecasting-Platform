/**
 * Reference-data import.
 *
 * Two shapes accepted on the same endpoint: raw CSV in the body (Content-Type
 * text/csv), or `{ "csv": "..." }` / `{ "rows": [...] }` as JSON. The CSV path is
 * what a finance team will actually use, because it is what "save as CSV" from
 * their spreadsheet produces.
 *
 * `?apply=true` commits. Anything else - including omitting it - is a dry run,
 * because the safe reading of an ambiguous request against reference data is the
 * one that writes nothing.
 */
import type { FastifyInstance } from 'fastify';
import { AppError, queryBoolean } from '@ffp/shared';
import { z } from 'zod';
import { requireUser } from '../plugins/auth.plugin.js';
import {
  importAccounts,
  importBusinessUnits,
  type ImportInput,
} from '../services/refdata.service.js';

const bodySchema = z.union([
  z.object({ csv: z.string().min(1) }),
  z.object({ rows: z.array(z.record(z.string(), z.unknown())).min(1) }),
]);

/** Pull the rows out of whichever body shape arrived. */
function readInput(body: unknown, rawContentType: string | undefined): ImportInput {
  if (typeof body === 'string') {
    if (body.trim() === '') throw new AppError('VALIDATION_ERROR', 'The uploaded file was empty.');
    return body;
  }

  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    throw new AppError(
      'VALIDATION_ERROR',
      'Send the file as text/csv, or JSON of the form {"csv": "..."} or {"rows": [...]}.',
      { details: { received: rawContentType ?? 'unknown' } },
    );
  }

  if ('csv' in parsed.data) return parsed.data.csv;
  return parsed.data.rows.map((row) => {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(row)) {
      out[key] = value === null || value === undefined ? '' : String(value);
    }
    return out;
  });
}

export async function registerImportRoutes(app: FastifyInstance): Promise<void> {
  // The generic parser in app.ts turns any non-JSON body into a string, so CSV
  // arrives here intact without a dedicated parser.

  const guard = { onRequest: [app.requirePermission('settings:manage')] };

  app.post('/business-units', guard, async (request) => {
    const actor = requireUser(request);
    const { apply } = z
      .object({ apply: queryBoolean.optional().default(false) })
      .parse(request.query);

    return importBusinessUnits(readInput(request.body, request.headers['content-type']), actor, {
      apply,
      ipAddress: request.ip,
      userAgent: request.headers['user-agent'] ?? undefined,
    });
  });

  app.post('/accounts', guard, async (request) => {
    const actor = requireUser(request);
    const { apply } = z
      .object({ apply: queryBoolean.optional().default(false) })
      .parse(request.query);

    return importAccounts(readInput(request.body, request.headers['content-type']), actor, {
      apply,
      ipAddress: request.ip,
      userAgent: request.headers['user-agent'] ?? undefined,
    });
  });

  /**
   * The column contract, served next to the endpoint that consumes it.
   * A template someone can download beats documentation they have to find.
   */
  app.get('/templates/:entity', { onRequest: [app.authenticate] }, async (request, reply) => {
    const { entity } = z
      .object({ entity: z.enum(['business-units', 'accounts']) })
      .parse(request.params);

    const csv =
      entity === 'business-units'
        ? 'code,name,parentCode,costCentre,currency,isActive\n' +
          'GRP,Group,,,USD,true\n' +
          'MOB,Mobile Networks,GRP,CC-1000,USD,true\n'
        : 'code,name,type,category,parentCode,spendCategory,costBehaviour,variableShare,isActive\n' +
          '4000,Service Revenue,REVENUE,,,,,,true\n' +
          '6100,Network Energy,OPEX,INDIRECT,,FACILITIES,SEMI_VARIABLE,0.35,true\n';

    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="${entity}-template.csv"`)
      .send(csv);
  });
}
