// Load search and load details for the voice agent.
//
// What the agent sends is spoken input ("Georgia", "a reefer"), so every filter is normalized to the
// TMS's exact codes first; unrecognized values come back as a clear 422 the agent can act on
// ("ask the carrier to repeat the state") instead of a silent empty search.
//
// The broker ceiling (MAX_BUY) never appears in any response: responses are built field by field
// from an allow-list (toPublic*), never by spreading the internal record.
//
// Both routes require the call to have passed the one-time code check (D-008). The check happens here, in the
// service, so it holds even if the agent is talked into skipping verification: the carrier gets no loads.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { TmsClient, TmsFailure } from '../tms/client.js';
import type { LoadDetail, LoadSummary } from '../tms/records.js';
import { normalizeCity, normalizeEquipment, normalizeState } from '../tms/normalize.js';
import { blocksLoad, type CallStateStore } from '../storage/call-state.js';
import type { CallRecords } from '../storage/twin.js';
import { isVerified } from '../verification/service.js';

const searchBody = z.object({
  call_id: z.string().uuid(),
  origin_city: z.string().max(60).optional(),
  origin_state: z.string().max(40).optional(),
  destination_city: z.string().max(60).optional(),
  destination_state: z.string().max(40).optional(),
  equipment: z.string().max(40).optional(),
  limit: z.number().int().min(1).max(10).default(3), // a voice pitch can't list more than a few
}).strict();

const loadIdParam = z.object({ loadId: z.string().regex(/^LD\d{1,10}$/) });
const callQuery = z.object({ call_id: z.string().uuid() });

const NOT_VERIFIED = { error: 'not_verified', message: 'The carrier has not been verified. Send and check the one-time code before discussing any load.' };

const place = (p: { city: string; state: string }) => `${p.city}, ${p.state}`;

export function toPublicSummary(l: LoadSummary) {
  return {
    load_id: l.loadId,
    origin: place(l.origin),
    destination: place(l.destination),
    pickup_at: l.pickupAt.toISOString(),
    equipment: l.equipment,
    posted_rate_usd: l.postedRate,
    miles: l.miles,
  };
}

export function toPublicDetail(l: LoadDetail) {
  return {
    ...toPublicSummary(l),
    delivery_at: l.deliveryAt.toISOString(),
    weight_lbs: l.weightLbs,
    commodity: l.commodity,
    pieces: l.pieces,
    dimensions: l.dimensions,
    notes: l.notes,
    status: l.status,
  };
}

function failure(reply: { code: (n: number) => { send: (b: unknown) => unknown } }, e: TmsFailure) {
  if (e.kind === 'unavailable') {
    // Retry is the agent's call; the message is what it can say out loud.
    return reply.code(503).send({ error: 'tms_unavailable', retryable: true, message: 'The load board is not responding right now.' });
  }
  return reply.code(422).send({ error: 'tms_rejected', message: e.message });
}

export function registerLoadRoutes(app: FastifyInstance, tms: TmsClient, state: CallStateStore, records?: CallRecords): void {
  app.post('/v1/loads/search', async (request, reply) => {
    const parsed = searchBody.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request', issues: parsed.error.issues.map((i) => i.path.join('.')) });
    const b = parsed.data;
    if (!(await isVerified(state, b.call_id))) return reply.code(403).send(NOT_VERIFIED);

    const filters: Record<string, string> = {};
    const unrecognized: string[] = [];
    if (b.origin_state) { const s = normalizeState(b.origin_state); s ? (filters.ORIG_STATE = s) : unrecognized.push('origin_state'); }
    if (b.destination_state) { const s = normalizeState(b.destination_state); s ? (filters.DEST_STATE = s) : unrecognized.push('destination_state'); }
    if (b.equipment) { const e = normalizeEquipment(b.equipment); e ? (filters.EQTYPE = e) : unrecognized.push('equipment'); }
    if (b.origin_city?.trim()) filters.ORIG_CITY = normalizeCity(b.origin_city);
    if (b.destination_city?.trim()) filters.DEST_CITY = normalizeCity(b.destination_city);

    if (unrecognized.length) {
      const hints: Record<string, string> = {
        origin_state: 'the pickup state (a US state name or its two-letter code)',
        destination_state: 'the delivery state (a US state name or its two-letter code)',
        equipment: 'the equipment type (dry van, reefer, flatbed, step deck or power only)',
      };
      return reply.code(422).send({
        error: 'unrecognized_input', fields: unrecognized,
        message: `Ask the carrier to repeat ${unrecognized.map((f) => hints[f]).join(' and ')}.`,
      });
    }
    if (Object.keys(filters).length === 0) {
      return reply.code(422).send({ error: 'no_filters', message: 'Ask where the carrier wants to pick up, where they are headed, or their equipment.' });
    }

    const r = await tms.searchLoads({ ...filters, MAX_RESULTS: 50 });
    if (!r.ok) return failure(reply, r.error);

    const now = Date.now();
    const open = r.value
      .filter((l) => l.status === 'OPEN' && l.pickupAt.getTime() > now) // never pitch a load whose pickup has passed
      .sort((a, b2) => a.pickupAt.getTime() - b2.pickupAt.getTime());
    // Skip loads held for another carrier, awaiting a rep's confirmation (D-025).
    const free: typeof open = [];
    for (const l of open) {
      if (free.length >= b.limit) break;
      const hold = await state.getReservation(l.loadId);
      if (!blocksLoad(hold) || hold.callId === b.call_id) free.push(l);
    }
    const loads = free.map(toPublicSummary);
    // Audit trail: what was searched and what came back (ids only). A logging failure never breaks the call.
    await records?.event(b.call_id, 'search', { filters, results: loads.map((l) => l.load_id) })
      .catch((e: Error) => request.log.warn({ event: 'audit_write_failed', error: e.message.slice(0, 200) }));
    return { count: loads.length, loads };
  });

  app.get('/v1/loads/:loadId', async (request, reply) => {
    const p = loadIdParam.safeParse(request.params);
    if (!p.success) return reply.code(400).send({ error: 'invalid_load_id' });
    const q = callQuery.safeParse(request.query);
    if (!q.success) return reply.code(400).send({ error: 'call_id_required' });
    if (!(await isVerified(state, q.data.call_id))) return reply.code(403).send(NOT_VERIFIED);
    const r = await tms.getLoad(p.data.loadId);
    if (!r.ok) return failure(reply, r.error);
    if (r.value === null) return reply.code(404).send({ error: 'load_not_found' });
    return toPublicDetail(r.value);
  });
}
