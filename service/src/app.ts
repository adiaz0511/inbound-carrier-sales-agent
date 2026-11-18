import Fastify, { type FastifyInstance } from 'fastify';
import formbody from '@fastify/formbody';
import rateLimit from '@fastify/rate-limit';
import type { Config } from './config.js';
import { registerAuth } from './auth.js';
import { buildLine, sendRequest } from './tms/wire.js';
import { TmsClient } from './tms/client.js';
import { registerLoadRoutes } from './routes/loads.js';
import { registerCarrierRoutes } from './routes/carrier.js';
import { registerVerificationRoutes } from './routes/verification.js';
import { registerDealRoutes } from './routes/deal.js';
import { registerOpsRoutes } from './routes/ops.js';
import { CensusClient, FmcsaClient } from './carriers/fmcsa.js';
import { FirestoreCallStateStore, type CallStateStore } from './storage/call-state.js';
import { CallRecords, TwinWriter } from './storage/twin.js';
import { TwinReader } from './storage/twin-reader.js';

export interface Deps {
  tms?: TmsClient;
  fmcsa?: FmcsaClient;
  census?: CensusClient;
  state?: CallStateStore;
  records?: CallRecords;
  reader?: TwinReader;
}

export async function buildApp(config: Config, deps: Deps = {}): Promise<FastifyInstance> {
  // Fastify's default request logs contain method, URL and status, never headers or bodies,
  // so credentials and tokens stay out of logs.
  // trustProxy: Cloud Run sits behind Google's front end, which sets X-Forwarded-For.
  const app = Fastify({ logger: { level: 'info' }, trustProxy: true });

  await app.register(formbody); // the token endpoint takes application/x-www-form-urlencoded (RFC 6749)

  // Rate limits per caller IP (in memory, per instance; with at most 2 instances this bounds abuse).
  // Runs before authentication, so floods of unauthenticated requests are cut off too.
  // Default for API routes; the token endpoint sets a stricter limit on its own route.
  await app.register(rateLimit, { global: true, max: 300, timeWindow: '1 minute' });

  registerAuth(app, config);

  const tms = deps.tms ?? new TmsClient({
    host: config.TMS_HOST, port: config.TMS_PORT, token: config.TMS_AUTH_TOKEN, timeoutMs: config.TMS_TIMEOUT_MS, maxAttempts: config.TMS_MAX_ATTEMPTS,
    faultMode: config.TMS_FAULT_MODE,
    log: (event) => app.log.warn(event, 'tms'),
  });

  app.get('/health', async () => ({ status: 'ok', environment: config.ENVIRONMENT, tms_breaker_open: tms.breakerOpen }));

  // Local runs write to Twin staging and use a 'local' prefix in Firestore, never production data.
  const twinEnv = config.ENVIRONMENT === 'production' ? 'production' : 'staging';
  const warn = (event: Record<string, unknown>) => app.log.warn(event);
  const state = deps.state ?? new FirestoreCallStateStore(config.ENVIRONMENT, config.GCP_PROJECT_ID);
  const records = deps.records ?? new CallRecords(new TwinWriter({ apiKey: config.TWIN_WRITER_API_KEY, environment: twinEnv, log: warn }), twinEnv);

  registerCarrierRoutes(app, {
    fmcsa: deps.fmcsa ?? new FmcsaClient(config.FMCSA_WEB_KEY, { log: warn }),
    census: deps.census ?? new CensusClient({ log: warn }),
    state, records,
  });
  registerVerificationRoutes(app, { state, records, hashKey: config.OTP_HASH_KEY, channels: config.CODE_CHANNELS });
  registerLoadRoutes(app, tms, state, records);
  registerDealRoutes(app, { state, records, tms });
  // Ops dashboard reads (D-026): read-only Twin key, and the holds list from the same state store.
  const reader = deps.reader ?? new TwinReader({ apiKey: config.TWIN_READER_API_KEY, environment: twinEnv });
  registerOpsRoutes(app, { reader, records, state });

  // Phase 0 diagnostic: proves this deployment can reach the TMS over TCP.
  // DEBUG_ECHO skips the TMS's fault injection (R-16), so a failure here means a network or auth problem.
  app.get('/v1/diagnostics/tms', async (_request, reply) => {
    const started = Date.now();
    const outcome = await sendRequest(
      { host: config.TMS_HOST, port: config.TMS_PORT, timeoutMs: config.TMS_TIMEOUT_MS },
      buildLine('DEBUG_ECHO', config.TMS_AUTH_TOKEN, { MSG: 'health' }),
    );
    const ms = Date.now() - started;
    if (outcome.kind === 'ok') return { tms: 'reachable', ms };
    if (outcome.kind === 'error') return reply.code(502).send({ tms: 'error', code: outcome.code, ms });
    return reply.code(502).send({ tms: 'unreachable', reason: outcome.kind, ms });
  });

  return app;
}
