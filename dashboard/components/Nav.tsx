'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const GROUPS = [
  {
    label: 'Monitor',
    links: [
      { href: '/', label: 'Overview', icon: 'overview' },
      { href: '/calls', label: 'Calls', icon: 'calls' },
    ],
  },
  {
    label: 'Workspace',
    links: [
      { href: '/holds', label: 'Holds', icon: 'holds' },
      { href: '/onboarding', label: 'Onboarding', icon: 'onboarding' },
    ],
  },
];

export default function Nav({ activeHolds = 0 }: { activeHolds?: number }) {
  const path = usePathname();
  return (
    <nav className="nav-groups" aria-label="Main navigation">
      {GROUPS.map((group) => (
        <div className="nav-group" key={group.label}>
          <div className="nav-section-label">{group.label}</div>
          <div className="nav-items">
            {group.links.map((link) => {
              const active = link.href === '/' ? path === '/' : path === link.href || path.startsWith(`${link.href}/`);
              return (
                <Link key={link.href} href={link.href} className={active ? 'navlink active' : 'navlink'} aria-current={active ? 'page' : undefined}>
                  <NavIcon name={link.icon} />
                  <span>{link.label}</span>
                  {link.href === '/holds' && activeHolds > 0 ? <span className="nav-badge" aria-label={`${activeHolds} active holds`}>{activeHolds}</span> : null}
                </Link>
              );
            })}
          </div>
        </div>
      ))}
    </nav>
  );
}

function NavIcon({ name }: { name: string }) {
  if (name === 'overview') {
    return <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="2.5" y="2.5" width="4" height="4" rx="0.5" /><rect x="9.5" y="2.5" width="4" height="4" rx="0.5" /><rect x="2.5" y="9.5" width="4" height="4" rx="0.5" /><rect x="9.5" y="9.5" width="4" height="4" rx="0.5" /></svg>;
  }
  if (name === 'calls') {
    return <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M4.2 2.5 6 5.7 4.8 7c.7 1.6 1.7 2.6 3.3 3.3L9.4 9l3.2 1.8-.3 2.5c-.1.5-.5.8-1 .8-4.9-.3-9-4.4-9.3-9.3 0-.5.3-.9.8-1l1.4-.3Z" /></svg>;
  }
  if (name === 'holds') {
    return <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M4 2.5h8v11H4z" /><path d="M6 5h4M6 8h4M6 11h2" /></svg>;
  }
  return <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><circle cx="8" cy="5" r="2.5" /><path d="M3.5 13c.5-2.4 2-3.6 4.5-3.6s4 1.2 4.5 3.6" /></svg>;
}
