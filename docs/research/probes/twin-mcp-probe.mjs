// Twin-over-MCP probe used for R-24: service token from the API key, then SELECT and atomic UPDATE ... RETURNING via query_twin. Needs scratch table zz_mcp_probe in Twin staging (create first, drop after). Never prints secrets.
// Run: node docs/research/probes/twin-mcp-probe.mjs .env
import fs from 'node:fs';
const env = Object.fromEntries(fs.readFileSync(process.argv[2], 'utf8').split('\n').filter(l => /^[A-Z_]+=/.test(l)).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
const tok = await (await fetch('https://platform.happyrobot.ai/api/mcp/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'client_credentials', client_secret: env.HAPPYROBOT_API_KEY }) })).json();
const URL = 'https://mcp.platform.happyrobot.ai/twin/mcp';
const H = { Authorization: 'Bearer ' + tok.access_token, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
let sid = null, id = 0;
async function rpc(method, params) {
  const h = { ...H }; if (sid) h['mcp-session-id'] = sid;
  const t0 = performance.now();
  const r = await fetch(URL, { method: 'POST', headers: h, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) });
  sid = r.headers.get('mcp-session-id') || sid;
  const txt = await r.text(); const ms = Math.round(performance.now() - t0);
  const m = txt.match(/data: (.*)/); return { ms, status: r.status, body: m ? JSON.parse(m[1]) : (txt ? JSON.parse(txt) : null) };
}
const init = await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'carrier-sales-probe', version: '0' } });
console.log('initialize:', init.status, init.ms + 'ms');
await fetch(URL, { method: 'POST', headers: { ...H, 'mcp-session-id': sid }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
const tests = [
  ["atomic counter", "UPDATE zz_mcp_probe SET attempts = attempts + 1 WHERE id = 'probe-1' RETURNING attempts"],
  ["insert", "INSERT INTO zz_mcp_probe (id, attempts) VALUES ('probe-2', 0) ON CONFLICT (id) DO NOTHING RETURNING id"],
  ["conditional (expired code never matches)", "UPDATE zz_mcp_probe SET attempts = attempts + 1 WHERE id = 'probe-2' AND attempts < 3 RETURNING attempts"],
];
for (const [n, sql] of tests) { const r = await rpc('tools/call', { name: 'query_twin', arguments: { environment: 'staging', sql } }); const t = JSON.parse(r.body.result.content[0].text); console.log(n + ':', r.ms + 'ms', t.success, t.status, JSON.stringify(t.result?.rows), t.error || ''); }
