// POST /v1/carrier/check: the carrier-check tool (Phase 3).
//
// Body, as the HappyRobot workflow sends it:
//   call_id        fixed by the workflow (current.run_id), hidden from the model
//   run_url        fixed by the workflow (current.run_url), for the audit trail
//   mc_number      what the carrier said (the model fills this)
//   registry_*     the carrier's row from Twin, read by a native "Read from Twin" step in the same tool and
//                  passed as hidden fixed values; empty when the carrier isn't in broker records (D-019)
//
// The workflow passes values as text, and missing ones as empty strings, so the schema accepts both.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { checkCarrier, type CheckDeps } from '../carriers/check.js';

const text = (max: number) => z.preprocess((v) => (v === '' || v === null ? undefined : v), z.string().max(max).optional());
const bool = z.preprocess((v) => (v === 'true' || v === true ? true : v === 'false' || v === false || v === '' || v == null ? false : v), z.boolean());

const body = z.object({
  call_id: z.string().uuid(),
  run_url: z.preprocess((v) => (v === '' ? undefined : v), z.string().url().max(500).optional()),
  mc_number: z.string().min(1).max(40),
  registry_mc_number: text(20),
  registry_legal_name: text(200),
  registry_contact_phone: text(40),
  registry_contact_email: text(254),
  registry_is_sandbox: bool.optional(),
  registry_status: text(20),
}).strict();

export function registerCarrierRoutes(app: FastifyInstance, deps: Omit<CheckDeps, 'log'>): void {
  app.post('/v1/carrier/check', async (request, reply) => {
    const parsed = body.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_request', issues: parsed.error.issues.map((i) => i.path.join('.') || i.message) });
    }
    const b = parsed.data;
    const registry = b.registry_mc_number
      ? { mcNumber: b.registry_mc_number, legalName: b.registry_legal_name, contactPhone: b.registry_contact_phone,
          contactEmail: b.registry_contact_email, isSandbox: b.registry_is_sandbox, status: b.registry_status }
      : undefined;
    return checkCarrier(
      { callId: b.call_id, runUrl: b.run_url, mcSpoken: b.mc_number, registry },
      { ...deps, log: (e) => request.log.info(e, 'carrier_check') },
    );
  });
}
