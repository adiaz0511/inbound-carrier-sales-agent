import { humanize } from '@/lib/format';

const TONE: Record<string, string> = {
  booked: 'good',
  booked_ref_pending: 'warn',
  reserved: 'warn',
  confirmed: 'good',
  released: 'muted',
  verified: 'good',
  failed: 'bad',
  open: 'info',
  eligible: 'good',
  tms_unavailable: 'bad',
  declined: 'bad',
  transferred: 'info',
  in_progress: 'info',
  expired: 'bad',
  under_15_minutes: 'warn',
  test_record: 'muted',
};

export default function Badge({ value }: { value: string | null | undefined }) {
  const tone = (value && TONE[value]) || 'muted';
  return <span className={`badge ${tone}`}>{humanize(value)}</span>;
}
