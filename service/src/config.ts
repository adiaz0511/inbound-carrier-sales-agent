import { z } from 'zod';

// All configuration comes from environment variables (locally from .env, on Cloud Run from Secret Manager).
// The service refuses to start if anything required is missing, so a bad deploy fails loudly, not mid-call.
const secret = (name: string) => z.string().min(32, `${name} must be at least 32 characters`);

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(8080),
  // Which deployment this is. Tokens are bound to it, so a staging token is useless on production.
  ENVIRONMENT: z.enum(['local', 'staging', 'production']).default('local'),

  // OAuth2 client credentials (D-016). The workflow client gets the 'carrier-calls' scope.
  OAUTH_CLIENT_ID: z.string().min(3),
  OAUTH_CLIENT_SECRET: secret('OAUTH_CLIENT_SECRET'),
  // Second OAuth2 client for the ops dashboard (D-027). It gets the 'ops' scope, and only the ops routes accept it.
  OPS_CLIENT_ID: z.string().min(3).default('ops-dashboard'),
  OPS_CLIENT_SECRET: secret('OPS_CLIENT_SECRET'),
  // Key that signs access tokens. During a rotation, the old key goes in OAUTH_SIGNING_KEY_PREVIOUS
  // so tokens issued just before the switch stay valid until they expire.
  OAUTH_SIGNING_KEY: secret('OAUTH_SIGNING_KEY'),
  OAUTH_SIGNING_KEY_PREVIOUS: z.string().optional().transform((v) => (v ? v : undefined)),
  OAUTH_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),

  // HappyRobot key with only the 'Twin writer' role (Insert + Update Twin data), for durable records (D-018, D-019).
  TWIN_WRITER_API_KEY: z.string().min(20),
  // HappyRobot key with read-only Twin access, for the ops dashboard's reads (D-026). Never used to write.
  TWIN_READER_API_KEY: z.string().min(20),
  GCP_PROJECT_ID: z.string().optional(),

  FMCSA_WEB_KEY: z.string().min(10),
  // Key for the keyed hash of one-time codes (D-008). Production's is created in Secret Manager (D-018).
  OTP_HASH_KEY: secret('OTP_HASH_KEY'),
  // Channels a one-time code may be sent on: the ones the workflow can deliver (D-023). Email only until
  // an SMS sender exists; add 'sms' once it does. Separate with ';' (gcloud reads ',' as a list separator).
  CODE_CHANNELS: z.string().default('email').transform((v, ctx) => {
    const list = [...new Set(v.split(/[;,]/).map((c) => c.trim().toLowerCase()).filter(Boolean))];
    if (!list.length || list.some((c) => c !== 'sms' && c !== 'email')) {
      ctx.addIssue({ code: 'custom', message: 'must list sms and/or email, separated by ;' });
      return z.NEVER;
    }
    return list as ('sms' | 'email')[];
  }),

  TMS_HOST: z.string().min(1),
  TMS_PORT: z.coerce.number().int().positive(),
  TMS_AUTH_TOKEN: z.string().min(1),
  TMS_FAULT_MODE: z.enum(['off', 'down', 'timeout', 'garbage']).default('off'),
  // Tuned from soak tests (R-31): healthy replies peak at ~0.73 s, so 1.2 s per attempt with 4 attempts
  // gave 100% success over 300 operations against ~16% injected faults.
  TMS_TIMEOUT_MS: z.coerce.number().int().positive().default(1200),
  TMS_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(6).default(4),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    // Names only, never values.
    const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${problems}`);
  }
  if (parsed.data.OAUTH_SIGNING_KEY_PREVIOUS !== undefined && parsed.data.OAUTH_SIGNING_KEY_PREVIOUS.length < 32) {
    throw new Error('Invalid configuration: OAUTH_SIGNING_KEY_PREVIOUS must be at least 32 characters');
  }
  // Each client maps to exactly one scope, so the two client ids must differ.
  if (parsed.data.OPS_CLIENT_ID === parsed.data.OAUTH_CLIENT_ID) {
    throw new Error('Invalid configuration: OPS_CLIENT_ID must differ from OAUTH_CLIENT_ID');
  }
  // D-030 is a staging demo control. Refuse to start rather than risk simulating TMS failures in production.
  if (parsed.data.ENVIRONMENT === 'production' && parsed.data.TMS_FAULT_MODE !== 'off') {
    throw new Error('Invalid configuration: TMS_FAULT_MODE must be off in production (D-030)');
  }
  return parsed.data;
}
