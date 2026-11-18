import Link from 'next/link';
import { notFound } from 'next/navigation';
import Badge from '@/components/Badge';
import ErrorPanel from '@/components/ErrorPanel';
import LocalTime from '@/components/LocalTime';
import { ServiceError, opsGet } from '@/lib/service';
import { eventSentence } from '@/lib/events';
import { count, humanize, isoOf, isTestRecord, money, num, numOrNull, laneText, equipmentText } from '@/lib/format';
import type { CallDetail, Row } from '@/lib/types';
import { parseUuid } from '@/lib/validate';

export const dynamic = 'force-dynamic';

const str = (v: unknown): string => (v === null || v === undefined || v === '' ? '—' : String(v));
const yes = (v: unknown): string => (v === true || v === 'true' ? 'Yes' : 'No');

export default async function CallPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: raw } = await params;
  const id = parseUuid(raw);
  if (!id) notFound();

  let detail: CallDetail;
  try {
    detail = await opsGet<CallDetail>(`/v1/ops/calls/${encodeURIComponent(id)}`);
  } catch (e) {
    if (e instanceof ServiceError && e.kind === 'http' && e.status === 404) notFound();
    return (
      <>
        <BackLink />
        <ErrorPanel error={e} />
      </>
    );
  }

  const c: Row = detail.call;
  // Only https links leave the dashboard, so a stored value can't become a javascript: link.
  const runUrl = typeof c.run_url === 'string' && /^https:\/\//.test(c.run_url) ? c.run_url : null;
  const posted = numOrNull(c.posted_rate_usd);
  const agreed = numOrNull(c.agreed_rate_usd);
  const notes = typeof c.notes === 'string' && c.notes.trim() ? c.notes.trim() : null;
  const testRecord = isTestRecord(notes);

  return (
    <>
      <BackLink />
      <div className="page-head">
        <div>
          <h1>Call details</h1>
          <p>
            Started <LocalTime iso={isoOf(c.started_at)} />
            <span className="mono"> {str(c.call_id)}</span>
          </p>
          {testRecord ? <span className="detail-test-record"><Badge value="test_record" /></span> : null}
        </div>
        <div className="form-row">
          {runUrl ? (
            <a className="btn secondary" href={runUrl} target="_blank" rel="noopener noreferrer">
              Open HappyRobot run
            </a>
          ) : null}
        </div>
      </div>

      <section className="card panel agent-summary" aria-labelledby="agent-summary-title">
        <h2 id="agent-summary-title">Call notes</h2>
        <p>{notes ?? 'No notes were recorded for this call.'}</p>
      </section>

      <dl className="summary-strip" aria-label="Call summary">
        <Summary label="Outcome" value={<Badge value={(c.outcome as string | null) ?? 'in_progress'} />} />
        <Summary label="MC and carrier" value={<><span className="mono">{str(c.mc_number)}</span>, {str(c.carrier_name)}</>} />
        <Summary label="Lane" value={laneText(str(c.lane))} />
        <Summary label="Posted rate" value={posted === null ? '—' : money(posted)} />
        <Summary label="Agreed rate" value={agreed === null ? '—' : money(agreed)} />
      </dl>

      <section className="card panel">
        <h2>Call record</h2>
        <dl className="facts">
          <Fact label="Ended" value={<LocalTime iso={isoOf(c.ended_at)} />} />
          <Fact label="FMCSA result" value={humanize(c.fmcsa_result as string | null)} />
          <Fact label="Verification" value={humanize(c.verification_status as string | null)} />
          <Fact label="Load" value={str(c.load_id)} />
          <Fact label="Equipment" value={equipmentText(str(c.equipment))} />
          <Fact label="Counter rounds" value={`${count(num(c.counter_rounds))} ${num(c.counter_rounds) === 1 ? 'round' : 'rounds'}`} />
          <Fact label="Transferred" value={yes(c.transferred)} />
        </dl>
      </section>

      <section className="card panel">
        <h2>Events</h2>
        {detail.events.length === 0 ? (
          <p className="empty">No events recorded for this call.</p>
        ) : (
          <ol className="timeline">
            {detail.events.map((ev, i) => (
              <li key={`${ev.occurred_at}-${i}`}>
                <span className="time"><LocalTime iso={isoOf(ev.occurred_at)} /></span>
                <div className="event-content">
                  <p className="event-sentence">{eventSentence(ev.type, ev.detail)}</p>
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section className="panel">
        <h2 className="section-title">Offers</h2>
        {detail.offers.length === 0 ? (
          <p className="empty-block">No carrier offers were recorded for this call.</p>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th className="num">Round</th>
                  <th className="num">Carrier offer</th>
                  <th className="num">Our counter</th>
                  <th>Decision</th>
                </tr>
              </thead>
              <tbody>
                {detail.offers.map((o, i) => (
                  <tr key={`${str(o.round)}-${i}`}>
                    <td className="num">{str(o.round)}</td>
                    <td className="num">{numOrNull(o.carrier_offer_usd) === null ? '—' : money(num(o.carrier_offer_usd))}</td>
                    <td className="num">{numOrNull(o.counter_usd) === null ? '—' : money(num(o.counter_usd))}</td>
                    <td><Badge value={(o.decision as string | null) ?? null} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

function BackLink() {
  return (
    <p className="back-link">
      <Link href="/calls">All calls</Link>
    </p>
  );
}

function Summary({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="summary-item">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
