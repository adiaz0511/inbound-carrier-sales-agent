'use client';

import { useEffect, useState } from 'react';

// Renders a UTC ISO time. The first paint uses UTC so server and browser match; after mount it switches to the viewer's locale.
export default function LocalTime({ iso, dateOnly = false, relative = false }: { iso: string | null; dateOnly?: boolean; relative?: boolean }) {
  const [local, setLocal] = useState<string | null>(null);
  const [absolute, setAbsolute] = useState<string | null>(null);
  useEffect(() => {
    if (!iso) return;
    const d = new Date(iso);
    setAbsolute(d.toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
    }));
    if (relative) {
      const seconds = Math.round((d.getTime() - Date.now()) / 1000);
      const abs = Math.abs(seconds);
      const [value, unit] = abs < 60
        ? [seconds, 'second']
        : abs < 3600
          ? [Math.round(seconds / 60), 'minute']
          : abs < 86400
            ? [Math.round(seconds / 3600), 'hour']
            : [Math.round(seconds / 86400), 'day'];
      setLocal(new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(value, unit as Intl.RelativeTimeFormatUnit));
      return;
    }
    setLocal(dateOnly
      ? d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
      : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }));
  }, [iso, dateOnly, relative]);

  if (!iso) return <span>—</span>;
  const utc = new Date(iso).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  return <time dateTime={iso} title={relative ? absolute ?? undefined : undefined}>{local ?? utc}</time>;
}
