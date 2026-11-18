// A fake legacy TMS for tests: a real TCP server speaking the line protocol, scriptable per request so
// each fault the real server injects (R-15) can be reproduced on demand.
import net from 'node:net';

export type Behavior =
  | { reply: string }               // write exactly this (caller includes \r\n and END)
  | { timeout: true }               // read the request, never answer
  | { partial: string }             // write a prefix, then close without END
  | { holdOpen: string }            // write a full reply, then keep the connection open
  | { closeEmpty: true };           // close without writing anything

export interface FakeRequest { cmd: string; fields: Record<string, string> }

export async function startFakeTms(handler: (req: FakeRequest, n: number) => Behavior) {
  const requests: FakeRequest[] = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.setEncoding('ascii');
    let buf = '';
    socket.on('data', (chunk: string) => {
      buf += chunk;
      const end = buf.indexOf('\r\n');
      if (end === -1) return;
      const line = buf.slice(0, end);
      const fields = Object.fromEntries(line.split('|').map((p) => [p.slice(0, p.indexOf(':')), p.slice(p.indexOf(':') + 1)]));
      const req = { cmd: fields.CMD ?? '', fields };
      requests.push(req);
      const b = handler(req, requests.length);
      if ('reply' in b) { socket.end(b.reply); }
      else if ('partial' in b) { socket.end(b.partial); }
      else if ('holdOpen' in b) { socket.write(b.holdOpen); }
      else if ('closeEmpty' in b) { socket.end(); }
      // timeout: do nothing
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as net.AddressInfo).port;
  return {
    port,
    requests,
    close: () => new Promise<void>((r) => { for (const s of sockets) s.destroy(); server.close(() => r()); }),
  };
}

// Record builders using the live server's real widths (R-30).
const pad = (v: string | number, w: number) => String(v).padEnd(w, ' ');

export function summaryLine(o: Partial<Record<string, string | number>> = {}): string {
  const v = { LOAD_ID: 'LD01075', ORIG_CITY: 'El Paso', ORIG_STATE: 'TX', ORIG_ZIP: '79901', DEST_CITY: 'Sacramento', DEST_STATE: 'CA', DEST_ZIP: '95814', PICKUP_DT: '20261111054100', EQTYPE: 'FLATBED', RATE: 2037, MILES: 968, STATUS: 'OPEN', ...o };
  return [
    `LOAD_ID:${pad(v.LOAD_ID!, 12)}`, `ORIG_CITY:${pad(v.ORIG_CITY!, 30)}`, `ORIG_STATE:${v.ORIG_STATE}`, `ORIG_ZIP:${v.ORIG_ZIP}`,
    `DEST_CITY:${pad(v.DEST_CITY!, 30)}`, `DEST_STATE:${v.DEST_STATE}`, `DEST_ZIP:${v.DEST_ZIP}`, `PICKUP_DT:${v.PICKUP_DT}`,
    `EQTYPE:${pad(v.EQTYPE!, 10)}`, `RATE:${pad(v.RATE!, 8)}`, `MILES:${pad(v.MILES!, 6)}`, `STATUS:${pad(v.STATUS!, 8)}`,
  ].join('|');
}

export function detailLine(o: Partial<Record<string, string | number>> = {}, withMaxBuy = true): string {
  const v = { DELIVERY_DT: '20261114004100', WEIGHT: 22505, COMMODITY: 'Steel Coils', PIECES: 13, DIMS: '47ft x 8ft x 9ft', NOTES: '', MAX_BUY: 2274, ...o };
  const s = summaryLine(o).split('|');
  const head = s.slice(0, 8); // up to PICKUP_DT
  return [
    ...head, `DELIVERY_DT:${v.DELIVERY_DT}`, s[8]!, s[9]!, `WEIGHT:${pad(v.WEIGHT!, 8)}`, `COMMODITY:${pad(v.COMMODITY!, 30)}`,
    `PIECES:${pad(v.PIECES!, 6)}`, s[10]!, `DIMS:${pad(v.DIMS!, 30)}`, `NOTES:${pad(v.NOTES!, 120)}`, s[11]!,
    ...(withMaxBuy ? [`MAX_BUY:${pad(v.MAX_BUY!, 8)}`] : []),
  ].join('|');
}

export const END = 'END\r\n';
export const ok = (...lines: string[]) => ({ reply: lines.map((l) => l + '\r\n').join('') + END });
export const err = (code: string, msg = 'x') => ({ reply: `ERR|CODE:${code}|MSG:${msg}\r\n` });
