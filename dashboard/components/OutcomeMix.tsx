import { count, humanize } from '@/lib/format';

type Outcome = { key: string; value: number };
type Tone = 'good' | 'warn' | 'bad' | 'muted';

function toneFor(key: string): Tone {
  if (key === 'booked' || key === 'reserved' || key === 'confirmed') return 'good';
  if (key === 'released' || key === 'no_deal' || key === 'no_match') return 'warn';
  if (key === 'errors' || key === 'error' || key === 'tms_unavailable' || key === 'not_verified' || key === 'not_eligible') return 'bad';
  return 'muted';
}

export default function OutcomeMix({ outcomes }: { outcomes: Outcome[] }) {
  const sorted = [...outcomes].sort((a, b) => b.value - a.value);
  const total = sorted.reduce((sum, item) => sum + item.value, 0);
  if (total === 0) return <p className="empty">Call outcomes appear after a call ends.</p>;

  const summary = sorted.map((item) => `${humanize(item.key)} ${item.value}`).join(', ');
  return (
    <div className="outcome-mix">
      <div className="stacked-bar" role="img" aria-label={`Outcome mix: ${summary}`}>
        {sorted.map((item) => (
          <span
            className={`stacked-segment ${toneFor(item.key)}`}
            key={item.key}
            style={{ flexGrow: item.value }}
            title={`${humanize(item.key)}: ${count(item.value)} (${Math.round((item.value / total) * 100)}%)`}
          />
        ))}
      </div>
      <ul className="outcome-legend">
        {sorted.map((item) => (
          <li key={item.key}>
            <span className={`legend-swatch ${toneFor(item.key)}`} aria-hidden="true" />
            <span className="legend-label">{humanize(item.key)}</span>
            <span className="legend-value">{count(item.value)} <span className="muted">{Math.round((item.value / total) * 100)}%</span></span>
          </li>
        ))}
      </ul>
    </div>
  );
}
