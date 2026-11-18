'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { ServiceError, opsPost } from '@/lib/service';
import type { BookingResult } from '@/lib/types';

type ReleaseResult = { ok: true; status: 'released' } | { ok: false; reason: string };
import { parseInitials, parseLoadId, optionalText } from '@/lib/validate';

// Each action returns a query string for the holds page and redirects there. The redirect runs outside try/catch.

function flash(params: Record<string, string>): string {
  return `/holds?${new URLSearchParams(params).toString()}`;
}

function failure(e: unknown, load: string): string {
  if (e instanceof ServiceError && e.kind === 'http') {
    return flash({ flash: 'error', load, reason: e.code ?? String(e.status) });
  }
  return flash({ flash: 'error', load, reason: 'unreachable' });
}

export async function confirmBooking(formData: FormData): Promise<void> {
  const loadId = parseLoadId(formData.get('load_id'));
  const initials = parseInitials(formData.get('initials'));
  let target: string;
  if (!loadId || !initials) {
    target = flash({ flash: 'error', load: loadId ?? '', reason: 'invalid_request' });
  } else {
    try {
      const r = await opsPost<BookingResult>('/v1/reservations/confirm', { load_id: loadId, initials });
      target = r.ok
        ? flash({ flash: r.status, load: loadId, ref: r.booking_ref ?? '' })
        : flash({ flash: 'error', load: loadId, reason: r.reason });
    } catch (e) {
      target = failure(e, loadId);
    }
  }
  revalidatePath('/holds');
  redirect(target);
}

export async function releaseBooking(formData: FormData): Promise<void> {
  const loadId = parseLoadId(formData.get('load_id'));
  const initials = parseInitials(formData.get('initials'));
  const reason = optionalText(formData.get('reason'), 200);
  let target: string;
  if (!loadId || !initials || !reason) {
    target = flash({ flash: 'error', load: loadId ?? '', reason: 'invalid_request' });
  } else {
    try {
      const r = await opsPost<ReleaseResult>('/v1/reservations/release', { load_id: loadId, reason, initials });
      target = r.ok ? flash({ flash: 'released', load: loadId }) : flash({ flash: 'error', load: loadId, reason: r.reason });
    } catch (e) {
      target = failure(e, loadId);
    }
  }
  revalidatePath('/holds');
  redirect(target);
}
