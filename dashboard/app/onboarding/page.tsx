import { addCarrierContact, markContacted } from './actions';
import Badge from '@/components/Badge';
import ErrorPanel from '@/components/ErrorPanel';
import LocalTime from '@/components/LocalTime';
import Notice from '@/components/Notice';
import SubmitButton from '@/components/SubmitButton';
import { opsGet } from '@/lib/service';
import { humanize, isoOf } from '@/lib/format';
import type { OnboardingRequest } from '@/lib/types';

export const dynamic = 'force-dynamic';

const ERRORS: Record<string, string> = {
  not_found: 'That request is already closed or no longer exists.',
  unknown_carrier: 'No carrier with that MC number.',
  invalid_request: 'Check the initials and the other fields, then try again.',
  invalid_contact: 'That email or phone number is not valid.',
  contact_missing: 'Add an email or a phone number.',
  twin_unavailable: "Carrier records aren't responding. Try again in a minute.",
  unreachable: "The action didn't finish. Refresh the list before trying again.",
};

function resultNotice(sp: Record<string, string | undefined>) {
  if (sp.err && !sp.request) return <Notice tone="error">{ERRORS[sp.err] ?? ERRORS.unreachable}</Notice>;
  if (sp.ok === 'contacted') return <Notice tone="ok">Marked as contacted.</Notice>;
  if (sp.ok === 'contact') return <Notice tone="ok">Contact saved for MC {sp.mc}.</Notice>;
  return null;
}

export default async function OnboardingPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  let requests: OnboardingRequest[];
  try {
    requests = (await opsGet<{ requests: OnboardingRequest[] }>('/v1/ops/onboarding')).requests;
  } catch (e) {
    return (
      <>
        <div className="page-head"><div><h1>Onboarding</h1></div></div>
        <ErrorPanel error={e} />
      </>
    );
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Onboarding</h1>
          <p>Call each carrier, then mark the request contacted.</p>
        </div>
      </div>

      {resultNotice(sp)}

      {requests.length === 0 ? (
        <p className="empty-block">No callbacks waiting. New carrier callback requests appear here.</p>
      ) : (
        <div className="request-list">
          {requests.map((r) => (
            <section className="card request-row" key={r.request_id}>
              <div className="request-head">
                <div>
                  <h2>{r.carrier_name ?? 'Unknown carrier'}{r.mc_number ? ` (MC ${r.mc_number})` : ''}</h2>
                  <p className="muted">
                    Requested <LocalTime iso={isoOf(r.created_at)} />. {humanize(r.reason)}
                  </p>
                </div>
                <Badge value={r.status} />
              </div>

              {sp.err && sp.request === r.request_id ? (
                <div className="request-inline-notice">
                  <Notice tone="error">{ERRORS[sp.err] ?? ERRORS.unreachable}</Notice>
                </div>
              ) : null}

              <div className="request-forms">
                <form action={markContacted}>
                  <h3>Callback</h3>
                  <input type="hidden" name="request_id" value={r.request_id} />
                  <label className="field">
                    <span>Rep initials <span className="required">Required</span></span>
                    <input type="text" name="initials" className="input-initials" required aria-required="true" aria-describedby={`contacted-initials-${r.request_id}`} maxLength={5} pattern="[A-Za-z]{1,5}" title="Enter 1 to 5 letters" autoComplete="off" placeholder="AB" />
                    <span className="field-help" id={`contacted-initials-${r.request_id}`}>Use 1 to 5 letters.</span>
                  </label>
                  <label className="field">
                    Note (optional)
                    <input type="text" name="note" className="input-note" maxLength={500} autoComplete="off" />
                  </label>
                  <div className="request-actions">
                    <SubmitButton pendingLabel="Saving…">Mark contacted</SubmitButton>
                  </div>
                </form>

                {r.mc_number ? (
                  <form action={addCarrierContact}>
                    <h3>Add contact</h3>
                    <input type="hidden" name="mc" value={r.mc_number} />
                    <input type="hidden" name="request_id" value={r.request_id} />
                    <label className="field">
                      <span>Rep initials <span className="required">Required</span></span>
                      <input type="text" name="initials" className="input-initials" required aria-required="true" aria-describedby={`contact-initials-${r.request_id}`} maxLength={5} pattern="[A-Za-z]{1,5}" title="Enter 1 to 5 letters" autoComplete="off" placeholder="AB" />
                      <span className="field-help" id={`contact-initials-${r.request_id}`}>Use 1 to 5 letters.</span>
                    </label>
                    <label className="field">
                      Email
                      <input type="email" name="email" className="input-note" maxLength={254} autoComplete="email" placeholder="name@example.com" />
                    </label>
                    <label className="field">
                      Phone
                      <input type="tel" name="phone" className="input-note" maxLength={20} pattern="\+[1-9][0-9]{6,14}" title="Use +, country code, and phone number" placeholder="+13125550142" autoComplete="tel" inputMode="tel" />
                      <span className="field-help">Include + and country code. Add email, phone, or both.</span>
                    </label>
                    <div className="request-actions">
                      <SubmitButton className="btn secondary" pendingLabel="Saving…">Save contact</SubmitButton>
                    </div>
                  </form>
                ) : (
                  <p className="request-unavailable muted">Add the carrier MC before saving a contact.</p>
                )}
              </div>
            </section>
          ))}
        </div>
      )}
    </>
  );
}
