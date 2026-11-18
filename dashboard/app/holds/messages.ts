// Plain-language text for the booking and release results. Shared by the holds page and its actions.

export const REASON_TEXT: Record<string, string> = {
  expired: 'This hold expired. Release it or ask the carrier to call back.',
  released: 'This hold was already released. Check the board before contacting the carrier.',
  in_progress: 'This load is already being booked. Wait a minute, then check again.',
  tms_unavailable: "The load board isn't responding. Try again in a minute.",
  not_available: 'This load is no longer available. Check the board before calling back.',
  rate_rejected: 'The TMS rejected the agreed rate. Check the load before trying again.',
  no_reservation: 'No hold was found for this load. Check the load ID.',
  no_active_reservation: 'This load has no active hold. Refresh before trying again.',
  invalid_request: 'Check the rep initials and release reason, then try again.',
  twin_unavailable: "Carrier records aren't responding. Try again in a minute.",
};

export const ERROR_FALLBACK = "The action didn't finish. Refresh the list before trying again.";

export function reasonText(code: string | null | undefined): string {
  return (code && REASON_TEXT[code]) || ERROR_FALLBACK;
}
