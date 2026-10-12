const DAY_MS = 24 * 60 * 60 * 1000;

export const INVITE_DIALOG_NOTE = 'Anyone with this link can join as a member until it expires, so send it only to the people you want in. One link is enough for a whole class.';

export function inviteUsageText(uses: number): string {
  const count = Math.max(0, Math.floor(Number.isFinite(uses) ? uses : 0));
  if (count === 0) return 'Not used yet';
  if (count === 1) return 'Used once';
  return `Used ${count} times`;
}

export function inviteSummary(expiresAt: number, uses: number, now: number): string {
  const usage = inviteUsageText(uses);
  if (expiresAt <= now) return `Expired · ${usage}`;
  const days = Math.max(1, Math.ceil((expiresAt - now) / DAY_MS));
  return `Expires in ${days} ${days === 1 ? 'day' : 'days'} · ${usage}`;
}
