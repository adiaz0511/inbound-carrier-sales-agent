import { count } from '@/lib/format';

export type BarItem = { label: string; value: number; note?: string };

// Horizontal bars drawn with CSS only. Widths scale to the largest value in the list.
export default function Bars({ items, empty }: { items: BarItem[]; empty: string }) {
  if (items.length === 0 || items.every((i) => i.value === 0)) return <p className="empty">{empty}</p>;
  const max = Math.max(...items.map((i) => i.value));
  return (
    <ul className="bars">
      {items.map((i) => (
        <li key={i.label}>
          <span className="bar-label">{i.label}</span>
          <span className="bar-track" aria-hidden="true">
            <span className="bar-fill" style={{ width: `${Math.max(0, (i.value / max) * 100)}%` }} />
          </span>
          <span className="bar-value">
            {count(i.value)}
            {i.note ? <span className="muted"> {i.note}</span> : null}
          </span>
        </li>
      ))}
    </ul>
  );
}
