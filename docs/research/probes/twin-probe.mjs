// Twin REST timing probe used for R-22. Needs a scratch table zz_latency_probe in Twin staging (create it first, drop it after). Never prints the key.
// Run: node docs/research/probes/twin-probe.mjs .env
import fs from 'node:fs';
const env = Object.fromEntries(fs.readFileSync(process.argv[2], 'utf8').split('\n').filter(l => /^[A-Z_]+=/.test(l)).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
const B = 'https://platform.happyrobot.ai/api/v2/twin/tables/zz_latency_probe/rows';
const H = { Authorization: 'Bearer ' + env.HAPPYROBOT_API_KEY, 'Content-Type': 'application/json', 'x-twin-environment': 'staging' };
async function t(method, url, body) { const t0 = performance.now(); const r = await fetch(url, { method, headers: H, body: body && JSON.stringify(body) }); const txt = await r.text(); return { ms: Math.round(performance.now() - t0), status: r.status, txt }; }
const stats = (a) => { const s = a.map(x => x.ms).sort((x, y) => x - y); return `n=${s.length} p50=${s[Math.floor(s.length * .5)]} p90=${s[Math.floor(s.length * .9)]} max=${s.at(-1)} statuses=${JSON.stringify(a.reduce((o, x) => (o[x.status] = (o[x.status] || 0) + 1, o), {}))}`; };
const run = Date.now().toString(36);
const ins = [], upd = [], rd = [];
for (let i = 0; i < 20; i++) ins.push(await t('POST', B, { values: { id: `${run}-${i}`, attempts: '0', note: 'probe' } }));
console.log('first insert response:', ins[0].status, ins[0].txt.slice(0, 200));
for (let i = 0; i < 20; i++) upd.push(await t('PATCH', B, { primaryKey: { id: `${run}-${i}` }, updates: { attempts: '1' } }));
console.log('first update response:', upd[0].status, upd[0].txt.slice(0, 200));


console.log('INSERT', stats(ins)); console.log('UPDATE', stats(upd))
