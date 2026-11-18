// Negotiation, booking, mocked transfer and call end (Phase 5).
//
//   POST /v1/negotiation/start  { call_id, load_id }
//   POST /v1/negotiation/offer  { call_id, carrier_offer_usd }   number, or text like "2,300" / "$2300"
//   POST /v1/reservations       { call_id }                      agent: hold the load at the agreed price (D-025);
//                                                                price, MC and load come from call state
//   POST /v1/reservations/confirm { load_id, initials }          senior rep: the TMS booking (ops token, D-027)
//   POST /v1/reservations/release { load_id, reason, initials }  senior rep: put the load back on the board (ops token)
//   POST /v1/calls/transfer     { call_id }                      mocked senior-rep handoff
//   POST /v1/calls/end          { call_id, reason?, summary? }
//
// call_id is fixed by the workflow (current.run_id). Nothing here accepts a ceiling, a price to book, or an MC.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { END_REASONS, confirmReservation, endCall, releaseReservation, reserveLoad, startNegotiation, submitOffer, transferToRep, type DealDeps } from '../negotiation/service.js';

const callId = z.string().uuid();
const dollars = z.preprocess((v) => {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && /^\s*\$?\s*[\d,]+(\.0+)?\s*$/.test(v)) return Number(v.replace(/[$,\s]/g, ''));
  return v;
}, z.number().int().positive().max(100_000));
const blank = (v: unknown) => (v === '' || v === null ? undefined : v);
const initials = z.string().regex(/^[A-Za-z]{1,5}$/);

const schemas = {
  start: z.object({ call_id: callId, load_id: z.string().regex(/^LD\d{1,10}$/) }).strict(),
  offer: z.object({ call_id: callId, carrier_offer_usd: dollars }).strict(),
  call: z.object({ call_id: callId }).strict(),
  // Ops actions name the rep by initials (the ops token only says which client, not which person).
  confirm: z.object({ load_id: z.string().regex(/^LD\d{1,10}$/), initials: initials }).strict(),
  release: z.object({ load_id: z.string().regex(/^LD\d{1,10}$/), reason: z.string().min(1).max(200), initials: initials }).strict(),
  end: z.object({
    call_id: callId,
    // Ending a call must never fail: a reason outside the list is ignored (the service's own record decides
    // the outcome anyway, and the agent's reason only fills a gap).
    reason: z.preprocess((v) => (END_REASONS as readonly unknown[]).includes(v) ? v : undefined, z.enum(END_REASONS).optional()),
    summary: z.preprocess(blank, z.string().max(4000).optional()),
  }).strict(),
};

export function registerDealRoutes(app: FastifyInstance, deps: Omit<DealDeps, 'log'>): void {
  const withLog = (request: { log: { warn: (o: object) => void } }): DealDeps => ({ ...deps, log: (e) => request.log.warn(e) });
  const bad = (issues: z.ZodIssue[]) => ({ error: 'invalid_request', issues: issues.map((i) => i.path.join('.') || i.message) });

  app.post('/v1/negotiation/start', async (request, reply) => {
    const p = schemas.start.safeParse(request.body ?? {});
    if (!p.success) return reply.code(400).send(bad(p.error.issues));
    return startNegotiation({ callId: p.data.call_id, loadId: p.data.load_id }, withLog(request));
  });

  app.post('/v1/negotiation/offer', async (request, reply) => {
    const p = schemas.offer.safeParse(request.body ?? {});
    if (!p.success) return reply.code(400).send({ ...bad(p.error.issues), next_step: 'Ask the carrier to state their rate as a dollar amount.' });
    return submitOffer({ callId: p.data.call_id, askUsd: p.data.carrier_offer_usd }, withLog(request));
  });

  app.post('/v1/reservations', async (request, reply) => {
    const p = schemas.call.safeParse(request.body ?? {});
    if (!p.success) return reply.code(400).send(bad(p.error.issues));
    return reserveLoad({ callId: p.data.call_id }, withLog(request));
  });

  // Ops side (senior rep, via the dashboard). No agent tool points here.
  app.post('/v1/reservations/confirm', async (request, reply) => {
    const p = schemas.confirm.safeParse(request.body ?? {});
    if (!p.success) return reply.code(400).send(bad(p.error.issues));
    return confirmReservation({ loadId: p.data.load_id, by: `ops:${p.data.initials.toUpperCase()}` }, withLog(request));
  });

  app.post('/v1/reservations/release', async (request, reply) => {
    const p = schemas.release.safeParse(request.body ?? {});
    if (!p.success) return reply.code(400).send(bad(p.error.issues));
    const by = `ops:${p.data.initials.toUpperCase()}`;
    return releaseReservation({ loadId: p.data.load_id, reason: `${p.data.reason} (by ${by})` }, withLog(request));
  });

  app.post('/v1/calls/transfer', async (request, reply) => {
    const p = schemas.call.safeParse(request.body ?? {});
    if (!p.success) return reply.code(400).send(bad(p.error.issues));
    return transferToRep({ callId: p.data.call_id }, withLog(request));
  });

  app.post('/v1/calls/end', async (request, reply) => {
    const p = schemas.end.safeParse(request.body ?? {});
    if (!p.success) return reply.code(400).send(bad(p.error.issues));
    return endCall({ callId: p.data.call_id, reason: p.data.reason, summary: p.data.summary }, withLog(request));
  });
}
