import type { Metadata } from 'next';
import Link from 'next/link';
import Nav from '@/components/Nav';
import { opsGet } from '@/lib/service';
import type { Hold } from '@/lib/types';
import './globals.css';

export const metadata: Metadata = {
  title: 'Carrier Ops',
  description: 'Operations dashboard for inbound carrier sales',
};

// Read at request time so the environment label can change without a rebuild.
export const dynamic = 'force-dynamic';

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const env = process.env.DASHBOARD_ENV_LABEL?.trim() || 'staging';
  let activeHolds = 0;
  try {
    const holds = (await opsGet<{ holds: Hold[] }>('/v1/ops/holds')).holds;
    activeHolds = holds.filter((hold) => hold.status === 'reserved' && hold.minutesLeft !== null && hold.minutesLeft > 0).length;
  } catch {
    // Navigation remains usable when the optional badge cannot be loaded.
  }
  return (
    <html lang="en">
      <body>
        <a className="skip-link" href="#main-content">Skip to content</a>
        <div className="shell">
          <aside className="sidebar">
            <Link className="brand" href="/" aria-label="Carrier Ops overview">
              <div className="brand-title">Carrier Ops</div>
              <div className="brand-subtitle">HappyRobot Logistics</div>
            </Link>
            <Nav activeHolds={activeHolds} />
          </aside>
          <div className="workspace">
            <header className="context-bar">
              <span className="context-name">Carrier sales operations</span>
              <span className="env-badge">{env}</span>
            </header>
            <main className="content" id="main-content">{children}</main>
          </div>
        </div>
      </body>
    </html>
  );
}
