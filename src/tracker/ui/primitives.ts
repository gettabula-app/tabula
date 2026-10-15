import './tracker.css';
import { h } from '../../ui/dom';
import { actorBadgeGlyph, actorLabel, type ActorBadgeKind } from './glyphs';
import { ticketChipText } from './keys-util';
import { wordInitials } from '../../../shared/initials';

export function keyChip(key: string): HTMLElement {
  const display = ticketChipText(key);
  const match = /^([A-Z]{2,5}-)(\d+)$/i.exec(display);
  if (!match) return h('span', { class: 'trk-key-chip' }, display);
  return h('span', { class: 'trk-key-chip', 'aria-label': display },
    h('span', { class: 'trk-key-prefix', 'aria-hidden': 'true' }, match[1].toUpperCase()),
    h('span', { class: 'trk-key-number', 'aria-hidden': 'true' }, match[2]),
  );
}

export function labelChip(name: string, color?: string | null): HTMLElement {
  const chip = h('span', { class: 'trk-label-chip' }, name);
  if (color && /^#[\da-f]{3,8}$/i.test(color)) chip.style.setProperty('--trk-label-color', color);
  return chip;
}

export function countBadge(count: number, label?: string): HTMLElement {
  const safeCount = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  return h('span', {
    class: 'trk-count-badge',
    'aria-label': label ?? `${safeCount} ${safeCount === 1 ? 'issue' : 'issues'}`,
  }, String(safeCount));
}

export type AvatarActor =
  | { kind: 'person'; name: string; imageUrl?: string | null }
  | { kind: ActorBadgeKind; name?: string };

export function avatar(actor: AvatarActor): HTMLElement {
  if (actor.kind !== 'person') {
    return h('span', { class: 'trk-actor-badge', 'aria-label': actor.name ?? actorLabel(actor.kind) },
      actorBadgeGlyph(actor.kind),
      h('span', null, actor.name ?? actorLabel(actor.kind)),
    );
  }
  if (actor.imageUrl) {
    return h('span', { class: 'trk-avatar', role: 'img', 'aria-label': actor.name },
      h('img', { src: actor.imageUrl, alt: '', 'aria-hidden': 'true' }),
    );
  }
  return h('span', { class: 'trk-avatar', 'aria-label': actor.name }, wordInitials(actor.name) || '?');
}

function parseTrackerDate(value: string | number | Date): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'number') {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  const date = dateOnly ? new Date(`${value}T00:00:00.000Z`) : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  if (dateOnly && date.toISOString().slice(0, 10) !== value) return null;
  return date;
}

function utcDay(date: Date): number {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

export function formatTrackerDate(value: string | number | Date, now = Date.now(), options: { relative?: boolean } = {}): string {
  const date = parseTrackerDate(value);
  if (!date) return 'Unknown date';
  if (options.relative) {
    const today = new Date(now);
    if (Number.isNaN(today.getTime())) return 'Unknown date';
    const difference = Math.round((utcDay(date) - utcDay(today)) / 86_400_000);
    if (difference === -1) return 'Yesterday';
    if (difference === 0) return 'Today';
    if (difference === 1) return 'Tomorrow';
  }
  const month = new Intl.DateTimeFormat('en', { month: 'short', timeZone: 'UTC' }).format(date);
  const day = date.getUTCDate();
  const year = date.getUTCFullYear();
  const current = new Date(now);
  return year === current.getUTCFullYear() ? `${month} ${day}` : `${month} ${day}, ${year}`;
}

function absoluteTime(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? 'Unknown time' : `${formatTrackerDate(at)} · ${at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
}

export function formatRelative(now: number, iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(now) || Number.isNaN(then)) return 'Unknown time';
  const delta = then - now;
  const future = delta > 0;
  const seconds = Math.abs(delta) / 1000;
  // a time ahead of this clock is clock skew between server and client, never news: show it as now
  if (future) return 'just now';
  if (seconds < 60) return 'just now';
  const units: [number, string][] = [
    [60 * 60 * 24 * 365, 'year'], [60 * 60 * 24 * 30, 'month'], [60 * 60 * 24 * 7, 'week'],
    [60 * 60 * 24, 'day'], [60 * 60, 'hour'], [60, 'minute'],
  ];
  const [size, unit] = units.find(([secondsPerUnit]) => seconds >= secondsPerUnit)!;
  const amount = Math.floor(seconds / size);
  const text = `${amount} ${unit}${amount === 1 ? '' : 's'}`;
  return `${text} ago`;
}

export function relativeTime(now: number, iso: string): HTMLTimeElement {
  const absolute = absoluteTime(iso);
  const label = formatRelative(now, iso);
  return h('time', { class: 'trk-relative-time', dateTime: iso, title: absolute, 'aria-label': `${label} (${absolute})` },
    label,
  );
}

/** A finished ticket (completed or canceled) is never overdue: it only shows its date. */
export function dueChip(due: string | null, now: number, finished = false): HTMLElement | null {
  if (!due) return null;
  const parsed = parseTrackerDate(due);
  if (!parsed || !/^\d{4}-\d{2}-\d{2}$/u.test(due)) return h('span', { class: 'trk-due-chip' }, `Due ${formatTrackerDate(due, now)}`);
  const today = new Date(now).toISOString().slice(0, 10);
  const overdue = due < today && !finished;
  const relative = formatTrackerDate(due, now, { relative: true });
  const shortDate = formatTrackerDate(due, now);
  const text = due === today ? 'Due today' : due > today && relative === 'Tomorrow' ? 'Due tomorrow' : overdue ? `Overdue · ${relative === 'Yesterday' ? relative : shortDate}` : `Due ${shortDate}`;
  return h('span', {
    class: `trk-due-chip${overdue ? ' trk-overdue' : ''}`,
    'aria-label': overdue ? `Overdue, due ${shortDate}` : text,
  }, text);
}
