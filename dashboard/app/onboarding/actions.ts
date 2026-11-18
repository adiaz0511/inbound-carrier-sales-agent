'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { ServiceError, opsPost } from '@/lib/service';
import { isValidEmail, isValidPhone, optionalText, parseInitials, parseMc, parseUuid } from '@/lib/validate';

// Each action redirects back to the page with a short result code. The redirect runs outside try/catch.

function errorCode(e: unknown): string {
  if (e instanceof ServiceError && e.kind === 'http') return e.code ?? `status_${e.status}`;
  return 'unreachable';
}

export async function markContacted(formData: FormData): Promise<void> {
  const requestId = parseUuid(formData.get('request_id'));
  const initials = parseInitials(formData.get('initials'));
  const note = optionalText(formData.get('note'), 500);
  let target: string;
  if (!requestId || !initials) {
    target = `/onboarding?err=invalid_request${requestId ? `&request=${encodeURIComponent(requestId)}` : ''}`;
  } else {
    try {
      await opsPost(`/v1/ops/onboarding/${encodeURIComponent(requestId)}/contacted`, {
        initials,
        ...(note ? { note } : {}),
      });
      target = '/onboarding?ok=contacted';
    } catch (e) {
      target = `/onboarding?err=${encodeURIComponent(errorCode(e))}&request=${encodeURIComponent(requestId)}`;
    }
  }
  revalidatePath('/onboarding');
  redirect(target);
}

export async function addCarrierContact(formData: FormData): Promise<void> {
  const mc = parseMc(formData.get('mc'));
  const requestId = parseUuid(formData.get('request_id'));
  const initials = parseInitials(formData.get('initials'));
  const email = optionalText(formData.get('email'), 254);
  const phone = optionalText(formData.get('phone'), 20);
  let target: string;
  const requestParam = requestId ? `&request=${encodeURIComponent(requestId)}` : '';
  if (!mc || !initials || !requestId) {
    target = `/onboarding?err=invalid_request${requestParam}`;
  } else if (!email && !phone) {
    target = `/onboarding?err=contact_missing${requestParam}`;
  } else if ((email && !isValidEmail(email)) || (phone && !isValidPhone(phone))) {
    target = `/onboarding?err=invalid_contact${requestParam}`;
  } else {
    try {
      await opsPost(`/v1/ops/carriers/${encodeURIComponent(mc)}/contact`, {
        initials,
        ...(email ? { email } : {}),
        ...(phone ? { phone } : {}),
      });
      target = `/onboarding?ok=contact&mc=${encodeURIComponent(mc)}`;
    } catch (e) {
      target = `/onboarding?err=${encodeURIComponent(errorCode(e))}${requestParam}`;
    }
  }
  revalidatePath('/onboarding');
  redirect(target);
}
