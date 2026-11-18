// The ops dashboard's read API and senior-rep data actions (decisions D-026, D-027, D-028).
// Every route here needs the 'ops' scope (auth.ts). The voice agent never calls them, and their responses
// never go to the agent, so they may show margin and ceilings where the agent-facing routes must not.
//
//   GET  /v1/ops/kpis?days=7                        funnel, outcomes, reservations, margin, TMS errors
//   GET  /v1/ops/holds                              active holds, then holds closed in the last 24 h
//   GET  /v1/ops/calls?limit=50                     newest calls
//   GET  /v1/ops/calls/:callId                      one call with its events and offers
//   GET  /v1/ops/onboarding                         open carrier onboarding requests
//   POST /v1/ops/onboarding/:id/contacted           { initials, note? }
//   POST /v1/ops/carriers/:mc/contact               { initials, email?, phone? }
//
// SQL is fixed text. Every value put into it passes sqlInt / sqlUuid / sqlMc first (twin-reader.ts).
// Twin failures answer 503 with no internals.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { validEmail } from '../carriers/fmcsa.js';
import { isActiveHold, type CallStateStore, type Reservation } from '../storage/call-state.js';
import { TwinWriteError, type CallRecords } from '../storage/twin.js';
import { TwinReadError, TwinReader, isUuid, sqlInt, sqlMc, sqlUuid } from '../storage/twin-reader.js';

export interface OpsDeps {
  reader: TwinReader;
  records: CallRecords;
  state: CallStateStore;
}

type Row = Record<string, unknown>;
const DAY_MS = 24 * 3600 * 1000;
const PHONE_RE = /^\+[1-9][0-9]{6,14}$/;
const RESERVED_OUTCOMES = ['reserved', 'booked', 'booked_ref_pending', 'released'];
const MARGIN_OUTCOMES = ['reserved', 'booked', 'booked_ref_pending'];

// Twin returns every value as text, so these convert explicitly.
const num = (v: unknown): number => (v === null || v === undefined || v === '' ? 0 : Number(v));
const numOrNull = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number(v));
const iso = (v: unknown): string | null => {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v);
  const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s.replace(' ', 'T')}Z`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

// Query and path inputs. Numbers arrive as text; anything that isn't a plain integer in range is a 400.
const intParam = (min: number, max: number, def: number) =>
  z.string().regex(/^[0-9]{1,6}$/).optional()
    .transform((v) => (v === undefined ? def : Number(v)))
    .pipe(z.number().int().min(min).max(max));
const initials = z.string().regex(/^[A-Za-z]{1,5}$/);

const kpisQuery = z.object({ days: intParam(1, 90, 7) });
const callsQuery = z.object({ limit: intParam(1, 100, 50) });
const uuidParams = z.object({ callId: z.string() });
const onboardingParams = z.object({ id: z.string() });
const carrierParams = z.object({ mc: z.string().regex(/^[0-9]{1,8}$/) });
const contactedBody = z.object({ initials, note: z.string().max(500).optional() }).strict();
const carrierContactBody = z.object({
  initials,
  email: z.string().max(254).optional(),
  phone: z.string().max(20).optional(),
}).strict();

/** Runs a Twin call; a Twin failure becomes 503 with no details. */
async function twinGuard<T>(request: FastifyRequest, reply: FastifyReply, fn: () => Promise<T>): Promise<T | FastifyReply> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof TwinReadError || e instanceof TwinWriteError) {
      request.log.warn({ event: 'ops_twin_unavailable', status: e.status }, 'ops: Twin unavailable');
      return reply.code(503).send({ error: 'twin_unavailable' });
    }
    throw e;
  }
}

async function kpis(reader: TwinReader, days: number) {
  const d = sqlInt(days, 1, 90);
  const since = (col: string) => `${col} >= (now() AT TIME ZONE 'utc') - interval '${d} days'`;
  const [agg, outcomes, margin, errors] = await Promise.all([
    reader.query<Row>(`SELECT count(*) AS total,
        count(*) FILTER (WHERE fmcsa_result = 'eligible') AS eligible,
        count(*) FILTER (WHERE verification_status IN ('code_sent', 'verified', 'failed')) AS code_sent,
        count(*) FILTER (WHERE verification_status = 'verified') AS verified,
        count(*) FILTER (WHERE verification_status = 'failed') AS lockouts,
        avg(EXTRACT(EPOCH FROM (verified_at - started_at))::float8) FILTER (WHERE verified_at IS NOT NULL) AS avg_verify_s,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (verified_at - started_at))::float8)
          FILTER (WHERE verified_at IS NOT NULL) AS median_verify_s,
        avg(counter_rounds) FILTER (WHERE load_id IS NOT NULL) AS avg_counter_rounds
      FROM calls WHERE ${since('started_at')}`),
    reader.query<Row>(`SELECT COALESCE(outcome, 'in_progress') AS outcome, count(*) AS n
      FROM calls WHERE ${since('started_at')} GROUP BY 1`),
    reader.query<Row>(`SELECT count(*) AS deals,
        COALESCE(sum(p.margin_vs_ceiling_usd), 0) AS total_margin,
        avg(p.margin_vs_ceiling_usd)::float8 AS avg_margin,
        avg((p.ceiling_usd - p.agreed_rate_usd)::float8 / NULLIF(p.ceiling_usd - p.posted_rate_usd, 0))
          FILTER (WHERE p.ceiling_usd > p.posted_rate_usd AND p.agreed_rate_usd IS NOT NULL) AS avg_pct
      FROM load_pricing p JOIN calls c ON c.call_id = p.call_id
      WHERE ${since('c.started_at')} AND c.outcome IN (${MARGIN_OUTCOMES.map((o) => `'${o}'`).join(', ')})`),
    reader.query<Row>(`SELECT to_char(date_trunc('day', e.occurred_at), 'YYYY-MM-DD') AS day, count(*) AS count
      FROM call_events e WHERE e.type = 'error' AND ${since('e.occurred_at')} GROUP BY 1 ORDER BY 1`),
  ]);

  const a = agg[0] ?? {};
  const byOutcome: Record<string, number> = {};
  for (const r of outcomes) byOutcome[String(r.outcome ?? 'in_progress')] = num(r.n);
  const count = (k: string) => byOutcome[k] ?? 0;
  const verified = num(a.verified);
  const reservedTotal = RESERVED_OUTCOMES.reduce((s, k) => s + count(k), 0);
  const confirmed = count('booked') + count('booked_ref_pending');
  const m = margin[0] ?? {};

  return {
    window_days: d,
    total: num(a.total),
    by_outcome: byOutcome,
    funnel: {
      calls: num(a.total),
      eligible: num(a.eligible),
      code_sent: num(a.code_sent),
      verified,
      lockouts: num(a.lockouts),
    },
    time_to_verify_seconds: { avg: numOrNull(a.avg_verify_s), median: numOrNull(a.median_verify_s) },
    reservations: {
      reserved_total: reservedTotal,
      reservation_rate: verified > 0 ? reservedTotal / verified : null,
      confirmed,
      confirmed_rate: reservedTotal > 0 ? confirmed / reservedTotal : null,
    },
    negotiation: { avg_counter_rounds: numOrNull(a.avg_counter_rounds) },
    margin: {
      deals: num(m.deals),
      total_margin_usd: num(m.total_margin),
      avg_margin_usd: numOrNull(m.avg_margin),
      avg_pct_of_room: numOrNull(m.avg_pct),
    },
    tms: {
      tms_unavailable_calls: count('tms_unavailable'),
      error_events_by_day: errors.map((r) => ({ day: String(r.day), count: num(r.count) })),
    },
  };
}

// Only these fields leave the service for holds: never the ceiling or the posted rate.
function holdView(r: Reservation, now: number) {
  const active = isActiveHold(r, now);
  return {
    loadId: r.loadId,
    callId: r.callId,
    mcNumber: r.mcNumber,
    carrierName: r.carrierName ?? null,
    lane: r.lane,
    equipment: r.equipment,
    priceUsd: r.priceUsd,
    status: r.status,
    expiresAt: new Date(r.expiresAt).toISOString(),
    minutesLeft: active ? Math.max(0, Math.floor((r.expiresAt - now) / 60_000)) : null,
    bookingRef: r.bookingRef ?? null,
    closedReason: r.closedReason ?? null,
  };
}

function callView(r: Row) {
  return {
    call_id: r.call_id,
    started_at: iso(r.started_at),
    ended_at: iso(r.ended_at),
    mc_number: r.mc_number ?? null,
    carrier_name: r.carrier_name ?? null,
    fmcsa_result: r.fmcsa_result ?? null,
    verification_status: r.verification_status ?? null,
    load_id: r.load_id ?? null,
    lane: r.lane ?? null,
    equipment: r.equipment ?? null,
    posted_rate_usd: numOrNull(r.posted_rate_usd),
    agreed_rate_usd: numOrNull(r.agreed_rate_usd),
    ceiling_usd: numOrNull(r.ceiling_usd),
    margin_kept_usd: numOrNull(r.margin_kept_usd),
    margin_kept_pct: numOrNull(r.margin_kept_pct),
    counter_rounds: num(r.counter_rounds),
    outcome: r.outcome ?? null,
    transferred: r.transferred === true || r.transferred === 'true',
    run_url: r.run_url ?? null,
  };
}

export function registerOpsRoutes(app: FastifyInstance, deps: OpsDeps): void {
  const { reader, records, state } = deps;
  const bad = (reply: FastifyReply) => reply.code(400).send({ error: 'invalid_request' });
  const notFound = (reply: FastifyReply, error: string) => reply.code(404).send({ error });

  app.get('/v1/ops/kpis', async (request, reply) => {
    const q = kpisQuery.safeParse(request.query ?? {});
    if (!q.success) return bad(reply);
    return twinGuard(request, reply, () => kpis(reader, q.data.days));
  });

  app.get('/v1/ops/holds', async () => {
    const now = Date.now();
    const all = await state.listReservations();
    const needsReview = all
      .filter((r) => r.status === 'booking_unresolved' || r.status === 'confirming')
      .sort((a, b) => (b.confirmationStartedAt ?? b.createdAt) - (a.confirmationStartedAt ?? a.createdAt));
    const active = all.filter((r) => isActiveHold(r, now)).sort((a, b) => a.expiresAt - b.expiresAt);
    const closed = all
      .filter((r) => (r.status === 'confirmed' || r.status === 'released') && (r.closedAt ?? 0) >= now - DAY_MS)
      .sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0));
    return { holds: [...needsReview, ...active, ...closed].map((r) => holdView(r, now)) };
  });

  app.get('/v1/ops/calls', async (request, reply) => {
    const q = callsQuery.safeParse(request.query ?? {});
    if (!q.success) return bad(reply);
    return twinGuard(request, reply, async () => {
      const rows = await reader.query<Row>(`SELECT c.call_id, c.started_at, c.ended_at, c.mc_number, c.carrier_name, c.fmcsa_result,
          c.verification_status, c.load_id, c.lane, c.equipment, c.posted_rate_usd, c.agreed_rate_usd, c.counter_rounds, c.outcome,
          c.transferred, c.run_url, p.ceiling_usd,
          CASE WHEN p.agreed_rate_usd IS NOT NULL THEN p.ceiling_usd - p.agreed_rate_usd ELSE NULL END AS margin_kept_usd,
          CASE WHEN p.ceiling_usd > p.posted_rate_usd
            THEN (p.ceiling_usd - p.agreed_rate_usd)::float8 / NULLIF(p.ceiling_usd - p.posted_rate_usd, 0)
            ELSE NULL END AS margin_kept_pct
        FROM calls c LEFT JOIN load_pricing p ON p.call_id = c.call_id
        ORDER BY c.started_at DESC LIMIT ${sqlInt(q.data.limit, 1, 100)}`);
      return { calls: rows.map(callView) };
    });
  });

  app.get('/v1/ops/calls/:callId', async (request, reply) => {
    const p = uuidParams.safeParse(request.params);
    if (!p.success || !isUuid(p.data.callId)) return bad(reply);
    const id = sqlUuid(p.data.callId);
    return twinGuard(request, reply, async () => {
      const [calls, events, offers] = await Promise.all([
        reader.query<Row>(`SELECT c.*, p.ceiling_usd,
            CASE WHEN p.agreed_rate_usd IS NOT NULL THEN p.ceiling_usd - p.agreed_rate_usd ELSE NULL END AS margin_kept_usd,
            CASE WHEN p.ceiling_usd > p.posted_rate_usd
              THEN (p.ceiling_usd - p.agreed_rate_usd)::float8 / NULLIF(p.ceiling_usd - p.posted_rate_usd, 0)
              ELSE NULL END AS margin_kept_pct
          FROM calls c LEFT JOIN load_pricing p ON p.call_id = c.call_id
          WHERE c.call_id = '${id}'`),
        reader.query<Row>(`SELECT type, occurred_at, detail FROM call_events WHERE call_id = '${id}' ORDER BY occurred_at`),
        reader.query<Row>(`SELECT * FROM offers WHERE call_id = '${id}' ORDER BY round`),
      ]);
      if (!calls[0]) return notFound(reply, 'not_found');
      return {
        call: {
          ...calls[0],
          ceiling_usd: numOrNull(calls[0].ceiling_usd),
          margin_kept_usd: numOrNull(calls[0].margin_kept_usd),
          margin_kept_pct: numOrNull(calls[0].margin_kept_pct),
        },
        events,
        offers,
      };
    });
  });

  app.get('/v1/ops/onboarding', async (request, reply) => {
    return twinGuard(request, reply, async () => {
      const rows = await reader.query<Row>(`SELECT request_id, call_id, mc_number, carrier_name, reason, status, created_at
        FROM onboarding_requests WHERE status = 'open' ORDER BY created_at DESC LIMIT 500`);
      return { requests: rows };
    });
  });

  app.post('/v1/ops/onboarding/:id/contacted', async (request, reply) => {
    const p = onboardingParams.safeParse(request.params);
    const b = contactedBody.safeParse(request.body ?? {});
    if (!p.success || !isUuid(p.data.id) || !b.success) return bad(reply);
    const id = sqlUuid(p.data.id);
    const note = b.data.note?.trim();
    const today = new Date().toISOString().slice(0, 10);
    return twinGuard(request, reply, async () => {
      const [row] = await reader.query<Row>(`SELECT status FROM onboarding_requests WHERE request_id = '${id}'`);
      if (!row || row.status !== 'open') return notFound(reply, 'not_found');
      // The note is a value in the writer's JSON body, never part of the SQL.
      const text = `Contacted by ${b.data.initials.toUpperCase()} on ${today}${note ? `: ${note}` : ''}`;
      await records.onboardingContacted(id, text);
      return { ok: true, request_id: id, status: 'open' };
    });
  });

  app.post('/v1/ops/carriers/:mc/contact', async (request, reply) => {
    const p = carrierParams.safeParse(request.params);
    const b = carrierContactBody.safeParse(request.body ?? {});
    if (!p.success || !b.success) return bad(reply);
    const rawEmail = b.data.email?.trim() || undefined;
    const email = rawEmail === undefined ? undefined : validEmail(rawEmail);
    const phone = b.data.phone?.trim() || undefined;
    if ((rawEmail !== undefined && !email) || (phone !== undefined && !PHONE_RE.test(phone)) || (!email && !phone)) {
      return bad(reply);
    }
    const mc = sqlMc(p.data.mc);
    return twinGuard(request, reply, async () => {
      const [row] = await reader.query<Row>(`SELECT mc_number FROM carriers WHERE mc_number = '${mc}'`);
      if (!row) return notFound(reply, 'unknown_carrier');
      await records.carrierContact(mc, { email, phone });
      return { ok: true, mc_number: mc, contact_email: email ?? null, contact_phone: phone ?? null };
    });
  });
}
