import Link from 'next/link';
import AutoRefresh from '@/components/AutoRefresh';
import Badge from '@/components/Badge';
import ErrorPanel from '@/components/ErrorPanel';
import LocalTime from '@/components/LocalTime';
import Notice from '@/components/Notice';
import { humanize, isoOf, money, laneText } from '@/lib/format';
import { opsGet } from '@/lib/service';
import type { CallDetail, Hold } from '@/lib/types';
import ActiveHolds, { type HoldWithCall } from './ActiveHolds';
import { reasonText } from './messages';

export const dynamic = 'force-dynamic';

function resultNotice(sp: Record<string, string | undefined>) {
  const load = sp.load ?? '';
  switch (sp.flash) {
    case 'booked':
      return <Notice tone="ok">Booked {load}. Booking ref {sp.ref || '—'}.</Notice>;
    case 'booked_ref_pending':
      return <Notice tone="ok">Booked {load}. The booking ref is not ready. Check the TMS.</Notice>;
    case 'released':
      return <Notice tone="ok">Released {load}. The load is back on the board.</Notice>;
    case 'error':
      return <Notice tone="error">{load ? `${load}: ` : ''}{reasonText(sp.reason)}</Notice>;
    default:
      return null;
  }
}

async function withCallRecord(hold: Hold): Promise<HoldWithCall> {
  try {
    const detail = await opsGet<CallDetail>(`/v1/ops/calls/${encodeURIComponent(hold.callId)}`);
    const rawNotes = detail.call.notes;
    const notes = typeof rawNotes === 'string' && rawNotes.trim() ? rawNotes.trim() : null;
    const closingType = hold.status === 'confirmed' ? 'booked' : 'reservation_released';
    const closingEvent = [...detail.events].reverse().find((event) => event.type === closingType);
    return { ...hold, notes, closedAt: isoOf(closingEvent?.occurred_at), expired: new Date(hold.expiresAt).getTime() <= Date.now() };
  } catch {
    return { ...hold, notes: null, closedAt: null, expired: new Date(hold.expiresAt).getTime() <= Date.now() };
  }
}

export default async function HoldsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const updatedAt = new Date().toISOString();
  let holds: Hold[];
  try {
    holds = (await opsGet<{ holds: Hold[] }>('/v1/ops/holds')).holds;
  } catch (e) {
    return (
      <>
        <PageHead updatedAt={updatedAt} />
        <ErrorPanel error={e} />
      </>
    );
  }

  const enriched = await Promise.all(holds.map(withCallRecord));
  const active = enriched
    .filter((hold) => hold.status === 'reserved')
    .sort((a, b) => (a.minutesLeft ?? Number.MAX_SAFE_INTEGER) - (b.minutesLeft ?? Number.MAX_SAFE_INTEGER));
  const closed = enriched
    .filter((hold) => hold.status === 'confirmed' || hold.status === 'released')
    .sort((a, b) => (b.closedAt ?? '').localeCompare(a.closedAt ?? ''));

  return (
    <>
      <PageHead updatedAt={updatedAt} />
      {resultNotice(sp)}

      <section className="holds-section" aria-labelledby="active-holds-title">
        <div className="section-heading">
          <h2 id="active-holds-title">Waiting for a rep</h2>
          <span className="section-count">{active.length}</span>
        </div>
        {active.length === 0 ? (
          <p className="empty-block">No holds waiting. When a carrier agrees a rate, the load appears here for a rep to confirm.</p>
        ) : (
          <ActiveHolds holds={active} />
        )}
      </section>

      <details className="closed-holds">
        <summary>
          <span>Closed in the last 24 h</span>
          <span className="section-count">{closed.length}</span>
        </summary>
        {closed.length === 0 ? (
          <p className="empty-block">No holds were confirmed or released in the last 24 h.</p>
        ) : (
          <ClosedTable holds={closed} />
        )}
      </details>
    </>
  );
}

function ClosedTable({ holds }: { holds: HoldWithCall[] }) {
  return (
    <div className="table-wrap">
      <table className="data-table holds-table">
        <thead>
          <tr>
            <th>Carrier</th>
            <th>Lane</th>
            <th className="num">Rate</th>
            <th>Outcome</th>
            <th>Reason / booking ref</th>
            <th>Closed at</th>
          </tr>
        </thead>
        <tbody>
          {holds.map((hold) => (
            <tr key={hold.loadId}>
              <td className="carrier-cell">
                <Link href={`/calls/${encodeURIComponent(hold.callId)}`}>{hold.carrierName ?? 'Unknown carrier'}</Link>
                <span className="carrier-mc">MC {hold.mcNumber}</span>
              </td>
              <td>{laneText(hold.lane)}</td>
              <td className="num">{money(hold.priceUsd)}</td>
              <td><Badge value={hold.status} /></td>
              <td className="identifier">{closedReference(hold)}</td>
              <td className="nowrap"><LocalTime iso={hold.closedAt} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function closedReference(hold: Hold): string {
  if (hold.bookingRef) return hold.bookingRef;
  const reason = hold.closedReason?.replace(/\s+\(by [A-Za-z]{1,5}\)$/i, '') ?? null;
  return humanize(reason);
}


function PageHead({ updatedAt }: { updatedAt: string }) {
  return (
    <div className="page-head">
      <div>
        <h1>Holds</h1>
        <p>Loads a carrier agreed to. Confirm to book in the TMS, or release to put it back on the board.</p>
      </div>
      <div className="page-meta"><AutoRefresh updatedAt={updatedAt} /></div>
    </div>
  );
}
