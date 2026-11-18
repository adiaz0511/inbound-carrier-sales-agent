import Link from 'next/link';
import Badge from '@/components/Badge';
import ErrorPanel from '@/components/ErrorPanel';
import LocalTime from '@/components/LocalTime';
import { isTestRecord, money, laneText } from '@/lib/format';
import { opsGet } from '@/lib/service';
import type { CallSummary } from '@/lib/types';

export const dynamic = 'force-dynamic';

export default async function CallsPage() {
  let calls: CallSummary[];
  try {
    calls = (await opsGet<{ calls: CallSummary[] }>('/v1/ops/calls?limit=50')).calls;
  } catch (e) {
    return (
      <>
        <div className="page-head"><div><h1>Calls</h1></div></div>
        <ErrorPanel error={e} />
      </>
    );
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Calls</h1>
        </div>
      </div>

      {calls.length === 0 ? (
        <p className="empty-block">No calls recorded. New carrier calls appear here when they start.</p>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Time</th>
                <th>MC</th>
                <th>Carrier</th>
                <th>Outcome</th>
                <th>Lane</th>
                <th className="num">Posted → agreed</th>
                <th className="num">Counters</th>
                <th>Transferred</th>
                <th>Call ID</th>
              </tr>
            </thead>
            <tbody>
              {calls.map((c) => (
                <tr className="data-row" key={c.call_id}>
                  <td className="nowrap"><Link className="data-row-link" href={`/calls/${encodeURIComponent(c.call_id)}`} aria-label={`View call ${c.call_id}`}><LocalTime iso={c.started_at} relative /></Link></td>
                  <td className="identifier">{c.mc_number ?? '—'}</td>
                  <td>
                    <span>{c.carrier_name ?? '—'}</span>
                    {isTestRecord(c.notes) ? <span className="test-record"><Badge value="test_record" /></span> : null}
                  </td>
                  <td><Badge value={c.outcome ?? 'in_progress'} /></td>
                  <td>{laneText(c.lane)}</td>
                  <td className="num">
                    {money(c.posted_rate_usd)} → {c.agreed_rate_usd === null ? '—' : money(c.agreed_rate_usd)}
                  </td>
                  <td className="num">{c.counter_rounds} {c.counter_rounds === 1 ? 'round' : 'rounds'}</td>
                  <td>{c.transferred ? 'Yes' : 'No'}</td>
                  <td className="identifier">{c.call_id.slice(0, 8)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
