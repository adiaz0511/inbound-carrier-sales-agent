// Soak test against the REAL TMS through the production client (retries, validation, breaker).
// Read-only: LOAD_QUERY and LOAD_GET only. Never books. Never prints the token.
//
//   npx tsx --env-file=../.env scripts/soak.ts [operations=300]
//
// Reports: success rate after retries, attempts per operation, faults by kind, latency percentiles.
import { TmsClient } from '../src/tms/client.js';

const N = Number(process.argv[2] ?? 300);
const faults: Record<string, number> = {};
let attemptsThisOp = 0; // faults seen in this operation
const client = new TmsClient({
  host: process.env.TMS_HOST!, port: Number(process.env.TMS_PORT), token: process.env.TMS_AUTH_TOKEN!,
  timeoutMs: Number(process.env.TMS_TIMEOUT_MS ?? 2000),
  maxAttempts: Number(process.env.TMS_MAX_ATTEMPTS ?? 3),
  log: (e) => {
    if (e.event === 'tms_fault') {
      attemptsThisOp += 1;
      const reason = String(e.reason).startsWith('malformed') ? 'malformed' : String(e.reason);
      faults[reason] = (faults[reason] ?? 0) + 1;
    }
  },
});

const equipment = ['DRY_VAN', 'REEFER', 'FLATBED', 'STEP_DECK', 'POWER_ONLY'];
let ids: string[] = [];
const results: { op: string; ok: boolean; ms: number; attempts: number; reason?: string }[] = [];

for (let i = 0; i < N; i++) {
  const doGet = ids.length > 0 && i % 3 === 2;
  attemptsThisOp = 0;
  const t0 = performance.now();
  let ok: boolean; let reason: string | undefined;
  if (doGet) {
    const r = await client.getLoad(ids[i % ids.length]!);
    ok = r.ok && r.value !== null; reason = r.ok ? undefined : r.error.kind === 'unavailable' ? r.error.reason : r.error.code;
  } else {
    const r = await client.searchLoads({ EQTYPE: equipment[i % equipment.length]!, MAX_RESULTS: 50 });
    ok = r.ok; reason = r.ok ? undefined : r.error.kind === 'unavailable' ? r.error.reason : r.error.code;
    if (r.ok && ids.length === 0) ids = r.value.map((l) => l.loadId);
  }
  results.push({ op: doGet ? 'get' : 'search', ok, ms: performance.now() - t0, attempts: attemptsThisOp + (ok ? 1 : 0), reason });
}

const pct = (a: number[], p: number) => a.sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))]!.toFixed(0);
const okCount = results.filter((r) => r.ok).length;
const rawAttempts = results.reduce((s, r) => s + r.attempts, 0);
const byAttempts = results.reduce<Record<number, number>>((m, r) => ((m[r.attempts] = (m[r.attempts] ?? 0) + 1), m), {});
const firstTry = results.filter((r) => r.ok && r.attempts === 1).map((r) => r.ms);
console.log(JSON.stringify({
  settings: { timeoutMs: Number(process.env.TMS_TIMEOUT_MS ?? 2000), maxAttempts: Number(process.env.TMS_MAX_ATTEMPTS ?? 3) },
  operations: N,
  succeeded_after_retries: okCount,
  success_rate: `${((okCount / N) * 100).toFixed(2)}%`,
  raw_requests: rawAttempts,
  raw_fault_rate: `${((Object.values(faults).reduce((a, b) => a + b, 0) / rawAttempts) * 100).toFixed(1)}%`,
  faults_by_kind: faults,
  operations_by_attempts: byAttempts,
  latency_ms: { p50: pct(results.map((r) => r.ms), 0.5), p90: pct(results.map((r) => r.ms), 0.9), p99: pct(results.map((r) => r.ms), 0.99), max: pct(results.map((r) => r.ms), 1) },
  healthy_first_try_latency_ms: { p50: pct([...firstTry], 0.5), p95: pct([...firstTry], 0.95), p99: pct([...firstTry], 0.99), max: pct([...firstTry], 1) },
  failures: results.filter((r) => !r.ok).map((r) => `${r.op}:${r.reason}`),
  breaker_opened: client.breakerOpen,
}, null, 2));
