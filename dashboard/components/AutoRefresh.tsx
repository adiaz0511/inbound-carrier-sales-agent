'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

const REFRESH_MS = 30_000;

function localClock(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
}

export default function AutoRefresh({ updatedAt }: { updatedAt: string }) {
  const router = useRouter();
  const [time, setTime] = useState<string | null>(null);

  useEffect(() => setTime(localClock(updatedAt)), [updatedAt]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;

    const schedule = () => {
      if (document.visibilityState !== 'visible') return;
      timer = setTimeout(() => {
        router.refresh();
        schedule();
      }, REFRESH_MS);
    };
    const visibilityChanged = () => {
      if (timer) clearTimeout(timer);
      timer = undefined;
      schedule();
    };

    document.addEventListener('visibilitychange', visibilityChanged);
    schedule();
    return () => {
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', visibilityChanged);
    };
  }, [router]);

  const utc = new Date(updatedAt).toISOString().slice(11, 19);
  return <span className="updated">Updated <time dateTime={updatedAt}>{time ?? utc}</time></span>;
}
