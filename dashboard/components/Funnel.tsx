import { count } from '@/lib/format';

export type FunnelStep = { label: string; value: number };

export default function Funnel({ steps }: { steps: FunnelStep[] }) {
  const first = steps[0]?.value ?? 0;
  if (first === 0) return <p className="empty">No completed calls in this period.</p>;

  const drops = steps.map((step, index) => {
    const previous = steps[index - 1]?.value;
    return index === 0 || !previous ? -1 : 1 - step.value / previous;
  });
  const biggestDrop = drops.indexOf(Math.max(...drops));

  return (
    <>
      <ol className="funnel" aria-label="Call conversion funnel">
        {steps.map((step, index) => {
          const previous = steps[index - 1]?.value;
          const conversion = index === 0 ? null : previous ? step.value / previous : 0;
          const isBiggestDrop = index === biggestDrop && drops[index] > 0;
          return (
            <li className={isBiggestDrop ? 'funnel-step drop-off' : 'funnel-step'} key={step.label}>
              <div className="funnel-row">
                <span className="funnel-label">{step.label}</span>
                <span className="funnel-value">{count(step.value)}</span>
              </div>
              <div className="funnel-track" aria-hidden="true">
                <span className="funnel-fill" style={{ width: `${Math.max(0, Math.min(100, (step.value / first) * 100))}%` }} />
              </div>
              <p className="funnel-conversion">
                {conversion === null ? 'All calls' : `${Math.round(conversion * 100)}% reached this step`}
                {isBiggestDrop ? <strong> Largest drop</strong> : null}
              </p>
            </li>
          );
        })}
      </ol>
      {first < 20 ? <p className="funnel-note">{count(first)} calls is a small sample. Treat percentages as directional.</p> : null}
    </>
  );
}
