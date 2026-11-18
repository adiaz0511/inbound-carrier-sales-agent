import Link from 'next/link';
import AutoRefresh from '@/components/AutoRefresh';
import Bars, { type BarItem } from '@/components/Bars';
import ErrorPanel from '@/components/ErrorPanel';
import Funnel, { type FunnelStep } from '@/components/Funnel';
import OutcomeMix from '@/components/OutcomeMix';
import { count, money, pct } from '@/lib/format';
import { opsGet } from '@/lib/service';
import type { Kpis } from '@/lib/types';

export const dynamic = 'force-dynamic';

const WINDOWS = [7, 30, 90] as const;

type Card = { label: string; value: string; sub?: string };

function cardsFrom(k: Kpis): { primary: Card[]; secondary: Card[] } {
  const ttv = k.time_to_verify_seconds.avg;
  const rounds = k.negotiation.avg_counter_rounds;
  return {
    primary: [
      {
        label: 'Reservation rate',
        value: pct(k.reservations.reservation_rate),
        sub: 'Verified carriers who agreed a rate and received a hold.',
      },
      {
        label: 'Margin kept',
        value: money(k.margin.total_margin_usd),
        sub: 'Below our ceiling on held and booked loads. Never shared with carriers.',
      },
      {
        label: 'Verified',
        value: k.total > 0 ? pct(k.funnel.verified / k.total) : '—',
        sub: 'Calls where the carrier passed identity checks.',
      },
      {
        label: 'Booked rate',
        value: pct(k.reservations.confirmed_rate),
        sub: 'Held loads a rep booked in the TMS.',
      },
    ],
    secondary: [
      { label: 'Calls', value: count(k.total) },
      { label: 'Verify time', value: ttv === null ? '—' : `${Math.round(ttv)} s` },
      { label: 'Counter rounds', value: rounds === null ? '—' : `${rounds.toFixed(1)} rounds` },
      { label: 'Failed verification', value: count(k.funnel.lockouts) },
    ],
  };
}

export default async function Overview({ searchParams }: { searchParams: Promise<{ days?: string }> }) {
  const sp = await searchParams;
  const requested = Number(sp.days);
  const days = (WINDOWS as readonly number[]).includes(requested) ? requested : 7;
  const updatedAt = new Date().toISOString();

  let k: Kpis;
  try {
    k = await opsGet<Kpis>(`/v1/ops/kpis?days=${days}`);
  } catch (e) {
    return (
      <>
        <PageHead days={days} updatedAt={updatedAt} />
        <ErrorPanel error={e} />
      </>
    );
  }

  const f = k.funnel;
  const funnel: FunnelStep[] = [
    { label: 'Calls', value: f.calls },
    { label: 'Eligible', value: f.eligible },
    { label: 'Code sent', value: f.code_sent },
    { label: 'Verified', value: f.verified },
    { label: 'Held', value: k.reservations.reserved_total },
    { label: 'Booked', value: k.reservations.confirmed },
  ];
  const outcomes = Object.entries(k.by_outcome).map(([key, value]) => ({ key, value }));
  const errors: BarItem[] = k.tms.error_events_by_day.map((d) => ({ label: d.day, value: d.count }));
  const empty = k.total === 0;
  const cards = cardsFrom(k);

  return (
    <>
      <PageHead days={days} updatedAt={updatedAt} />

      {empty ? <p className="empty-block">No completed calls in the last {days} days. Results appear after a call ends.</p> : null}

      <section className="grid-kpi" aria-label="Key figures">
        {cards.primary.map((c) => (
          <div className="card kpi" key={c.label}>
            <div className="label">{c.label}</div>
            <div className="kpi-value">{c.value}</div>
            {c.sub ? <div className="sub">{c.sub}</div> : null}
          </div>
        ))}
      </section>

      <section className="grid-kpi secondary" aria-label="Supporting figures">
        {cards.secondary.map((c) => (
          <div className="card kpi" key={c.label}>
            <div className="label">{c.label}</div>
            <div className="kpi-value">{c.value}</div>
            {c.sub ? <div className="sub">{c.sub}</div> : null}
          </div>
        ))}
      </section>

      <div className="two-col">
        <section className="card panel">
          <h2>Call progress</h2>
          <Funnel steps={funnel} />
        </section>

        <section className="card panel">
          <h2>Outcome mix</h2>
          <OutcomeMix outcomes={outcomes} />
        </section>
      </div>

      <section className="card panel">
        <h2>Load board errors</h2>
        <p className="muted note">
          {count(k.tms.tms_unavailable_calls)} calls ended because the load board was down.
        </p>
        <Bars items={errors} empty="No load board errors in this period." />
      </section>
    </>
  );
}

function PageHead({ days, updatedAt }: { days: number; updatedAt?: string }) {
  return (
    <div className="page-head">
      <div>
        <h1>Overview</h1>
        <p>Performance for the last {days} days.</p>
      </div>
      <div className="page-meta">
        {updatedAt ? <AutoRefresh updatedAt={updatedAt} /> : null}
        <nav className="segmented" aria-label="Reporting period">
          {WINDOWS.map((w) => (
            <Link key={w} href={`/?days=${w}`} className={w === days ? 'on' : undefined} aria-current={w === days ? 'page' : undefined}>
              {w} days
            </Link>
          ))}
        </nav>
      </div>
    </div>
  );
}
