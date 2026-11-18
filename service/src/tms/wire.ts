import net from 'node:net';

// Low-level TMS transport: one request per TCP connection (spec, R-11).
// Phase 0 only needs this for the DEBUG_ECHO reachability check; Phase 1 builds the full adapter
// (parsing by field name, validation, retries, booking reconciliation) on top of it.

export type WireOutcome =
  | { kind: 'ok'; lines: string[] }            // complete reply, ended by END
  | { kind: 'error'; code: string; message: string } // single ERR line
  | { kind: 'timeout'; partial: string }        // no complete reply in time
  | { kind: 'closed'; partial: string }         // server closed before END
  | { kind: 'socket_error'; reason: string };

export interface WireOptions {
  host: string;
  port: number;
  timeoutMs: number;
}

const MAX_FRAME = 64 * 1024; // guard against a server that never stops sending

export function sendRequest(opts: WireOptions, line: string): Promise<WireOutcome> {
  return new Promise((resolve) => {
    let buffer = '';
    let settled = false;
    const socket = net.createConnection({ host: opts.host, port: opts.port });

    const finish = (outcome: WireOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy(); // close at once: don't wait for the server (delayed-close fault, R-15)
      resolve(outcome);
    };

    const timer = setTimeout(() => finish({ kind: 'timeout', partial: buffer }), opts.timeoutMs);

    socket.setEncoding('ascii');
    socket.on('connect', () => socket.write(line + '\r\n'));
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      if (buffer.length > MAX_FRAME) return finish({ kind: 'closed', partial: buffer.slice(0, 200) });
      const err = /^ERR\|([^\r\n]*)\r\n/.exec(buffer);
      if (err) {
        const fields = Object.fromEntries(err[1]!.split('|').map((p) => [p.slice(0, p.indexOf(':')), p.slice(p.indexOf(':') + 1)]));
        return finish({ kind: 'error', code: fields.CODE ?? 'UNKNOWN', message: fields.MSG ?? '' });
      }
      const end = buffer.search(/(^|\r\n)END\r\n/);
      if (end !== -1) {
        const body = buffer.slice(0, end);
        return finish({ kind: 'ok', lines: body ? body.split('\r\n').filter(Boolean) : [] });
      }
    });
    socket.on('end', () => finish({ kind: 'closed', partial: buffer }));
    socket.on('close', () => finish({ kind: 'closed', partial: buffer }));
    socket.on('error', (e: NodeJS.ErrnoException) => finish({ kind: 'socket_error', reason: e.code ?? e.message }));
  });
}

// Builds CMD:...|AUTH:...|KEY:VALUE. Values may not contain | or line breaks (spec).
export function buildLine(cmd: string, token: string, fields: Record<string, string | number> = {}): string {
  const parts = [`CMD:${cmd}`, `AUTH:${token}`];
  for (const [k, v] of Object.entries(fields)) {
    const value = String(v);
    if (/[|\r\n]/.test(value) || !/^[A-Z_]+$/.test(k)) throw new Error(`Invalid TMS field ${k}`);
    parts.push(`${k}:${value}`);
  }
  return parts.join('|');
}
