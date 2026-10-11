export const TRACKER_NOTICE_REASONS = [
  'lane_unmapped',
  'lane_mapped',
  'card_stays_linked',
  'title_invalid',
  'forbidden',
  'read_only',
  'rate_limited',
  'bulk_change',
  'limit_exceeded',
  'conflict',
] as const;

export type TrackerNoticeReason = typeof TRACKER_NOTICE_REASONS[number];

const reasonSet = new Set<string>(TRACKER_NOTICE_REASONS);

const TEXT: Record<TrackerNoticeReason, string> = {
  lane_unmapped: "That lane isn't linked to a tracker state. The card went back.",
  lane_mapped: 'That lane is linked to the tracker. Unlink the kanban first.',
  card_stays_linked: 'Linked cards stay on their kanban. To move one, unlink the card, then link it again.',
  title_invalid: "That title can't be used. The card went back.",
  forbidden: "You can't change linked cards.",
  read_only: 'This workspace is read only right now.',
  rate_limited: 'Too many changes at once. The card went back.',
  bulk_change: 'That change touches too many linked cards. Nothing was applied.',
  limit_exceeded: 'Too many cards at once. Some stay plain cards.',
  conflict: 'The ticket changed first. The card went back.',
};

/** Unknown string reasons are treated as a conflict so a newer server can still give a useful notice. */
export function trackerNoticeReason(value: unknown): TrackerNoticeReason | null {
  if (typeof value !== 'string') return null;
  return reasonSet.has(value) ? value as TrackerNoticeReason : 'conflict';
}

/** Returns one short toast in contract priority order, regardless of how many cards share each reason. */
export function noticeText(reasons: readonly unknown[]): string {
  const present = new Set(reasons.map(trackerNoticeReason).filter((r): r is TrackerNoticeReason => r !== null));
  const first = TRACKER_NOTICE_REASONS.find((reason) => present.has(reason));
  return first ? TEXT[first] : '';
}
