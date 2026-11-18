// Read-only TMS probe used for R-17/R-18: DEBUG_ECHO, LOAD_QUERY, LOAD_GET. Never sends LOAD_BOOK. Never prints the token.
// Run: node docs/research/probes/tms-probe.mjs .env
import net from 'node:net';
import fs from 'node:fs';

const env = Object.fromEntries(fs.readFileSync(process.argv[2], 'utf8').split('\n')
  .filter(l => /^[A-Z_]+=/.test(l)).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
const { TMS_HOST: host, TMS_PORT: port, TMS_AUTH_TOKEN: token } = env;
const TIMEOUT = 8000;

function send(fields) {
  const line = ['CMD:' + fields.CMD, 'AUTH:' + token, ...Object.entries(fields).filter(([k]) => k !== 'CMD').map(([k, v]) => k + ':' + v)].join('|') + '\r\n';
  return new Promise(resolve => {
    const t0 = Date.now(); let buf = ''; let done = false; let firstByte = null;
    const s = net.createConnection({ host, port: Number(port) });
    const finish = (outcome) => { if (done) return; done = true; clearTimeout(timer); s.destroy(); resolve({ outcome, ms: Date.now() - t0, firstByteMs: firstByte, raw: buf }); };
    const timer = setTimeout(() => finish('TIMEOUT'), TIMEOUT);
    s.on('connect', () => s.write(line));
    s.on('data', d => {
      if (firstByte === null) firstByte = Date.now() - t0;
      buf += d.toString('ascii');
      if (/(^|\r\n)END\r\n/.test(buf)) finish('END');
      else if (/^ERR\|.*\r\n/.test(buf)) finish('ERR');
    });
    s.on('end', () => finish(buf ? 'CLOSED_NO_END' : 'CLOSED_EMPTY'));
    s.on('error', e => finish('SOCKET_ERROR ' + e.code));
  });
}
const redact = s => s.split(token).join('<token>');
const show = (label, r) => console.log(`--- ${label}: ${r.outcome} in ${r.ms} ms (first byte ${r.firstByteMs} ms)\n${redact(r.raw).replace(/\r\n/g, '⏎\n')}`);

console.log('host set:', !!host, 'port set:', !!port, 'token set:', !!token);
show('DEBUG_ECHO', await send({ CMD: 'DEBUG_ECHO', MSG: 'probe-1', X: '1' }));


// Board shape: one broad search per equipment type, big MAX_RESULTS.
const eq = {};
for (const e of ['DRY_VAN', 'REEFER', 'FLATBED', 'VAN', 'STEP_DECK', 'POWER_ONLY']) {
  const r = await send({ CMD: 'LOAD_QUERY', EQTYPE: e, MAX_RESULTS: 500 });
  const recs = r.raw.split('\r\n').filter(l => l.startsWith('LOAD_ID:'));
  eq[e] = r.outcome + ' ' + recs.length + ' recs ' + r.ms + 'ms';
  if (e === 'DRY_VAN' && recs[0]) console.log('dry van sample:', recs[0].replace(/ +\|/g, '|'));
}
console.log('by equipment:', eq);
// Fault sampling: 40 lookups and 20 searches.
const ids = ['LD01075', 'LD01097', 'LD01088', 'LD01100', 'LD01120'];
const out = { get: {}, query: {} }; const lat = []; const faults = [];
for (let i = 0; i < 40; i++) {
  const r = await send({ CMD: 'LOAD_GET', LOAD_ID: ids[i % 5] });
  out.get[r.outcome] = (out.get[r.outcome] || 0) + 1; lat.push(r.ms);
  const bad = r.outcome === 'END' && !/^LOAD_ID:[^\r\n]*\r\nEND\r\n$/.test(r.raw);
  if (r.outcome !== 'END' || bad) faults.push(`GET ${r.outcome}${bad ? ' (odd body)' : ''} ${r.ms}ms ${JSON.stringify(redact(r.raw).slice(0, 220))}`);
}
for (let i = 0; i < 20; i++) {
  const r = await send({ CMD: 'LOAD_QUERY', EQTYPE: 'REEFER', MAX_RESULTS: 3 });
  out.query[r.outcome] = (out.query[r.outcome] || 0) + 1; lat.push(r.ms);
  if (r.outcome !== 'END') faults.push(`QUERY ${r.outcome} ${r.ms}ms ${JSON.stringify(redact(r.raw).slice(0, 220))}`);
}
lat.sort((a, b) => a - b);
console.log('outcomes:', JSON.stringify(out), 'latency p50', lat[Math.floor(lat.length * .5)], 'p90', lat[Math.floor(lat.length * .9)], 'max', lat.at(-1));
console.log(faults.join('\n'));
// Error shapes.
for (const f of [{ CMD: 'LOAD_GET', LOAD_ID: 'LD99999' }, { CMD: 'LOAD_QUERY' }, { CMD: 'NOPE' }]) { const r = await send(f); console.log(JSON.stringify(f), '->', r.outcome, JSON.stringify(redact(r.raw))); }
