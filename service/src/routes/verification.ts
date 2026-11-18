// POST /v1/verification/send   { call_id, channel?, caller_email? }
// POST /v1/verification/check  { call_id, code }
//
// call_id is fixed by the workflow (current.run_id); the model never chooses it.
// POST /v1/verification/deliver { call_id }   -> { ok, channel, to, code } for the email/SMS step only.
// The model never sees the code: send returns safe fields only, and deliver is called by a separate workflow
// step whose whole output is hidden from the model (D-024). No agent tool points at deliver.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { checkCode, deliverCode, sendCode, type VerificationDeps } from '../verification/service.js';

const blank = (v: unknown) => (v === '' || v === null ? undefined : v);
const sendBody = z.object({
  call_id: z.string().uuid(),
  channel: z.preprocess(blank, z.enum(['sms', 'email']).optional()),
  caller_email: z.preprocess(blank, z.string().max(254).optional()),
}).strict();
const deliverBody = z.object({ call_id: z.string().uuid() }).strict();
const checkBody = z.object({ call_id: z.string().uuid(), code: z.string().min(1).max(40) }).strict();

export function registerVerificationRoutes(app: FastifyInstance, deps: Omit<VerificationDeps, 'log'>): void {
  // Guessing protection on top of the per-call limit: few legitimate calls need more than a handful per minute.
  const strict = { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } };

  app.post('/v1/verification/send', strict, async (request, reply) => {
    const p = sendBody.safeParse(request.body ?? {});
    if (!p.success) return reply.code(400).send({ error: 'invalid_request', issues: p.error.issues.map((i) => i.path.join('.')) });
    return sendCode(
      { callId: p.data.call_id, channel: p.data.channel, callerEmail: p.data.caller_email },
      { ...deps, log: (e) => request.log.warn(e) },
    );
  });

  app.post('/v1/verification/deliver', strict, async (request, reply) => {
    const p = deliverBody.safeParse(request.body ?? {});
    if (!p.success) return reply.code(400).send({ error: 'invalid_request', issues: p.error.issues.map((i) => i.path.join('.')) });
    return deliverCode({ callId: p.data.call_id }, { ...deps, log: (e) => request.log.warn(e) });
  });

  app.post('/v1/verification/check', strict, async (request, reply) => {
    const p = checkBody.safeParse(request.body ?? {});
    if (!p.success) return reply.code(400).send({ error: 'invalid_request', issues: p.error.issues.map((i) => i.path.join('.')) });
    return checkCode({ callId: p.data.call_id, codeSpoken: p.data.code }, { ...deps, log: (e) => request.log.warn(e) });
  });
}
