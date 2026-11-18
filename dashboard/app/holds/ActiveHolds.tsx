'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import ConfirmButton from '@/components/ConfirmButton';
import { money, laneText, equipmentText } from '@/lib/format';
import type { Hold } from '@/lib/types';
import { confirmBooking, releaseBooking } from './actions';

export type HoldWithCall = Hold & {
  notes: string | null;
  closedAt: string | null;
  expired: boolean;
};

const INITIALS_KEY = 'happyrobot.repInitials';
const INITIALS_PATTERN = /^[A-Za-z]{1,5}$/;

export default function ActiveHolds({ holds }: { holds: HoldWithCall[] }) {
  const [selected, setSelected] = useState<HoldWithCall | null>(null);
  const [initials, setInitials] = useState<string | null>(null);
  const [releaseOpen, setReleaseOpen] = useState(false);
  const [releaseReason, setReleaseReason] = useState('');
  const [checked, setChecked] = useState(false);
  const [initialsDraft, setInitialsDraft] = useState('');
  const [initialsError, setInitialsError] = useState('');
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!selected) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeButtonRef.current?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closePanel();
        return;
      }
      if (event.key !== 'Tab') return;
      const panel = closeButtonRef.current?.closest('[role="dialog"]');
      if (!panel) return;
      const focusable = Array.from(panel.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), [tabindex]:not([tabindex="-1"])',
      ));
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [selected]);

  function storedInitials(): string | null {
    try {
      const value = window.localStorage.getItem(INITIALS_KEY)?.trim().toUpperCase() ?? '';
      return INITIALS_PATTERN.test(value) ? value : null;
    } catch {
      return null;
    }
  }

  function openPanel(hold: HoldWithCall, trigger: HTMLButtonElement) {
    previousFocusRef.current = trigger;
    setInitials(storedInitials());
    setInitialsDraft('');
    setInitialsError('');
    setReleaseOpen(false);
    setReleaseReason('');
    setChecked(false);
    setSelected(hold);
  }

  function closePanel() {
    setSelected(null);
    window.requestAnimationFrame(() => previousFocusRef.current?.focus());
  }

  function saveInitials() {
    const value = initialsDraft.trim().toUpperCase();
    if (!INITIALS_PATTERN.test(value)) {
      setInitialsError('Enter 1 to 5 letters.');
      return;
    }
    try {
      window.localStorage.setItem(INITIALS_KEY, value);
    } catch {
      // The actions still work when browser storage is unavailable.
    }
    setInitials(value);
    setInitialsDraft('');
    setInitialsError('');
  }

  function changeInitials() {
    setInitialsDraft(initials ?? '');
    setInitials(null);
  }

  return (
    <>
      <div className="table-wrap">
        <table className="data-table holds-table">
          <thead>
            <tr>
              <th>Carrier</th>
              <th>Lane</th>
              <th>Equipment</th>
              <th className="num">Rate</th>
              <th>Time left</th>
              <th>Actions</th>
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
                <td className="nowrap">{equipmentText(hold.equipment)}</td>
                <td className="num">{money(hold.priceUsd)}</td>
                <td className="nowrap"><TimeLeft hold={hold} /></td>
                <td>
                  <button type="button" className="btn secondary" onClick={(event) => openPanel(hold, event.currentTarget)}>
                    Review
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {selected ? (
        <div className="review-backdrop" onMouseDown={(event) => event.target === event.currentTarget && closePanel()}>
          <aside className="review-panel" role="dialog" aria-modal="true" aria-labelledby="review-title">
            <header className="review-header">
              <div>
                <p className="review-context">Review hold</p>
                <h2 id="review-title">{selected.carrierName ?? 'Unknown carrier'}</h2>
                <p className="mono">MC {selected.mcNumber}</p>
              </div>
              <button ref={closeButtonRef} type="button" className="review-close" onClick={closePanel} aria-label="Close review">
                <span aria-hidden="true">×</span>
              </button>
            </header>

            <div className="review-body">
              <dl className="review-facts">
                <Fact label="Lane" value={laneText(selected.lane)} />
                <Fact label="Equipment" value={equipmentText(selected.equipment)} />
                <Fact label="Rate" value={money(selected.priceUsd)} />
                <Fact label="Time left" value={<TimeLeft hold={selected} />} />
              </dl>

              <section className="review-notes" aria-labelledby="call-notes-title">
                <div className="review-section-heading">
                  <h3 id="call-notes-title">Call notes</h3>
                  <Link href={`/calls/${encodeURIComponent(selected.callId)}`}>View call</Link>
                </div>
                <p>{selected.notes ?? 'No notes were recorded for this call.'}</p>
              </section>

              <section className="rep-identity" aria-label="Rep identity">
                {initials ? (
                  <p>Acting as <strong>{initials}</strong> <span aria-hidden="true">·</span> <button type="button" className="text-button" onClick={changeInitials}>change</button></p>
                ) : (
                  <div className="initials-entry">
                    <label className="field" htmlFor="rep-initials">
                      Rep initials <span className="required">Required</span>
                      <input
                        id="rep-initials"
                        type="text"
                        className="input-initials"
                        value={initialsDraft}
                        maxLength={5}
                        pattern="[A-Za-z]{1,5}"
                        autoComplete="off"
                        placeholder="AB"
                        aria-describedby={initialsError ? 'initials-error' : undefined}
                        aria-invalid={initialsError ? true : undefined}
                        onChange={(event) => {
                          setInitialsDraft(event.target.value);
                          setInitialsError('');
                        }}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            event.preventDefault();
                            saveInitials();
                          }
                        }}
                      />
                    </label>
                    <button type="button" className="btn secondary" onClick={saveInitials}>Continue</button>
                    {initialsError ? <p id="initials-error" className="field-error">{initialsError}</p> : null}
                  </div>
                )}
              </section>

              <div className="review-actions">
                <form action={confirmBooking} className="hold-action-form">
                  <input type="hidden" name="load_id" value={selected.loadId} />
                  <input type="hidden" name="initials" value={initials ?? ''} />
                  <label className="confirm-check">
                    <input type="checkbox" checked={checked} onChange={(event) => setChecked(event.target.checked)} disabled={!initials} />
                    <span>I checked the carrier and the rate</span>
                  </label>
                  <ConfirmButton
                    className="btn"
                    formAction={confirmBooking}
                    disabled={!initials || !checked}
                    confirmMessage={`Book ${selected.loadId} for ${selected.carrierName ?? `MC ${selected.mcNumber}`} at ${money(selected.priceUsd)}? This can't be undone.`}
                  >
                    Confirm booking
                  </ConfirmButton>
                </form>

                <div className="release-action">
                  {!releaseOpen ? (
                    <button type="button" className="btn secondary danger" onClick={() => setReleaseOpen(true)} disabled={!initials}>
                      Release load
                    </button>
                  ) : (
                    <form action={releaseBooking} className="hold-action-form">
                      <input type="hidden" name="load_id" value={selected.loadId} />
                      <input type="hidden" name="initials" value={initials ?? ''} />
                      <label className="field" htmlFor="release-reason">
                        Reason to release <span className="required">Required</span>
                        <input
                          id="release-reason"
                          type="text"
                          name="reason"
                          className="input-reason"
                          value={releaseReason}
                          onChange={(event) => setReleaseReason(event.target.value)}
                          maxLength={200}
                          required
                          autoComplete="off"
                        />
                      </label>
                      <div className="reason-picks" aria-label="Common release reasons">
                        {['Carrier backed out', 'Duplicate hold', 'Rate issue'].map((reason) => (
                          <button key={reason} type="button" className="reason-pick" onClick={() => setReleaseReason(reason)}>{reason}</button>
                        ))}
                      </div>
                      <ConfirmButton className="btn secondary danger" formAction={releaseBooking} requiredFields={['reason']}>
                        Release load
                      </ConfirmButton>
                    </form>
                  )}
                </div>
              </div>
            </div>
          </aside>
        </div>
      ) : null}
    </>
  );
}

function Fact({ label, value }: { label: string; value: React.ReactNode }) {
  return <div><dt>{label}</dt><dd>{value}</dd></div>;
}

function TimeLeft({ hold }: { hold: HoldWithCall }) {
  if (hold.expired) return <span className="time-left expired">Expired, release it</span>;
  if (hold.minutesLeft !== null && hold.minutesLeft <= 15) {
    return <span className="time-left soon">{hold.minutesLeft} min <span>Expires soon</span></span>;
  }
  return <span className="time-left">{hold.minutesLeft === null ? '—' : `${hold.minutesLeft} min`}</span>;
}


