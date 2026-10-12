/** Proposal for CGO review: the admin-only status banner wording. */
export function mailRefusalBanner(mail: { refusedRecently: number; reason: string | null } | undefined): string | null {
  if (!mail || mail.refusedRecently <= 0) return null;
  return `Sign-in emails were refused recently (${mail.reason ?? 'unknown'}). People may not receive their links.`;
}
