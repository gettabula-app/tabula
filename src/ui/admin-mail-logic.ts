/** Why sign-in emails failed, in words for an admin. One place for the map; the codes come from server/mail-health.mjs. */
const REASON_TEXT: Record<string, string> = {
  relay_rate_limited: 'too many were sent from this workspace',
  relay_error: 'the mail service refused them',
  network: 'the mail service was unreachable',
};

/** The admin-only banner (CGO's wording). The window is not known to the page, so it says "recently". */
export function mailRefusalBanner(mail: { refusedRecently: number; reason: string | null } | undefined): string | null {
  if (!mail || mail.refusedRecently <= 0) return null;
  const reason = REASON_TEXT[mail.reason ?? ''] ?? REASON_TEXT.relay_error;
  return `Some sign-in emails could not be sent recently: ${reason}. People who did not get their link can ask for a new one once this is fixed.`;
}
