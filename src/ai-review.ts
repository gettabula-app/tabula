import type { AiProposal } from './ai-apply';
import { STICKY_COLORS } from './palette';
import type { ProposedBy } from './types';

// Reviewing an AI proposal item by item before it is added (TAB-160, docs/ai.md "Reviewing a proposal"). A review is the
// reviewer's own: which items stay, and the words and colours they changed. `reviewed()` turns the proposal and the
// review into the proposal that is drawn on their screen and added, so what they see is what they add. Pure: no DOM.

/** The limits of the server's validator (server/ai/features.mjs FEATURE_LIMITS): an edit cannot make a proposal it would refuse. */
export const TEXT_MAX = 2000;
export const TITLE_MAX = 100;

export interface CreateItem { keep: boolean; text: string; color: string | undefined }
export interface GroupMember { id: string; keep: boolean; stale: boolean }
export interface GroupItem { keep: boolean; title: string; members: GroupMember[] }
export type Review =
  | { kind: 'create'; items: CreateItem[]; frame: { keep: boolean; title: string } | null }
  | { kind: 'group'; groups: GroupItem[] };

/** What a group member looked like when the proposal arrived: position, size, words, frame, kind and lock. */
export interface Fingerprint { x: number; y: number; w: number; h: number; text: string; parent: string; type: string; locked: boolean }

export function fingerprintOf(o: { x?: number; y?: number; w?: number; h?: number; text?: string; parent?: string; type?: string; locked?: boolean } | undefined): Fingerprint | null {
  if (!o) return null;
  return { x: o.x ?? 0, y: o.y ?? 0, w: o.w ?? 0, h: o.h ?? 0, text: o.text ?? '', parent: o.parent ?? '', type: o.type ?? '', locked: o.locked === true };
}

/** Whether a member changed since the proposal arrived (moved, resized, edited, put in another frame, locked, turned into another kind) or is gone. */
export function isStale(then: Fingerprint | null | undefined, now: Fingerprint | null): boolean {
  if (!now) return true;
  if (!then) return false;
  return then.x !== now.x || then.y !== now.y || then.w !== now.w || then.h !== now.h || then.text !== now.text || then.parent !== now.parent || then.type !== now.type || then.locked !== now.locked;
}

/** A fresh review: everything kept, except group members that changed since the proposal arrived. */
export function startReview(p: AiProposal, stale: (id: string) => boolean = () => false): Review {
  if (p.kind === 'create') {
    return {
      kind: 'create',
      items: p.objects.map((o) => ({ keep: true, text: o.text, color: o.color })),
      frame: p.frame ? { keep: true, title: p.frame.title } : null,
    };
  }
  return {
    kind: 'group',
    groups: p.groups.map((g) => ({ keep: true, title: g.title, members: g.ids.map((id) => ({ id, keep: !stale(id), stale: stale(id) })) })),
  };
}

/** Marks members stale that changed after the review started; a newly stale member is unticked once. */
export function refreshStale(r: Review, stale: (id: string) => boolean): Review {
  if (r.kind !== 'group') return r;
  let changed = false;
  const groups = r.groups.map((g) => ({
    ...g,
    members: g.members.map((m) => {
      const now = stale(m.id);
      if (now === m.stale) return m;
      changed = true;
      return { ...m, stale: now, keep: now ? false : m.keep };
    }),
  }));
  return changed ? { ...r, groups } : r;
}

const clip = (s: string, max: number) => [...s].slice(0, max).join('');
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();
const COLOR_NAMES = new Set(STICKY_COLORS.map((c) => c.name.toLowerCase()));
const colorName = (c: string | undefined) => (c && COLOR_NAMES.has(c.toLowerCase()) ? STICKY_COLORS.find((x) => x.name.toLowerCase() === c.toLowerCase())!.name : undefined);

/**
 * The proposal as reviewed: the kept items with their edited words and colours, in their order. A sticky whose text was
 * emptied is left out; a frame stays only with at least one sticky; a group needs a title and at least one kept member
 * that is not stale. Null when nothing is left to add.
 */
export function reviewed(p: AiProposal, r: Review): AiProposal | null {
  if (p.kind === 'create' && r.kind === 'create') {
    const objects = r.items
      .filter((i) => i.keep)
      .map((i) => ({ text: clip(i.text.trim(), TEXT_MAX), color: colorName(i.color) }))
      .filter((o) => o.text !== '')
      .map((o) => (o.color ? o : { text: o.text }));
    if (!objects.length) return null;
    const title = r.frame?.keep ? clip(oneLine(r.frame.title), TITLE_MAX) : '';
    return title ? { kind: 'create', objects, frame: { title } } : { kind: 'create', objects };
  }
  if (p.kind === 'group' && r.kind === 'group') {
    const groups = r.groups
      .filter((g) => g.keep)
      .map((g) => ({ title: clip(oneLine(g.title), TITLE_MAX), ids: g.members.filter((m) => m.keep && !m.stale).map((m) => m.id) }))
      .filter((g) => g.title !== '' && g.ids.length > 0);
    return groups.length ? { kind: 'group', groups } : null;
  }
  return null;
}

/** How many items are ticked and how many there are: stickies for a create, members for a group. */
export function reviewCounts(r: Review): { kept: number; total: number; stale: number } {
  if (r.kind === 'create') return { kept: r.items.filter((i) => i.keep && i.text.trim() !== '').length, total: r.items.length, stale: 0 };
  let kept = 0;
  let total = 0;
  let stale = 0;
  for (const g of r.groups) {
    for (const m of g.members) {
      total++;
      if (m.stale) stale++;
      if (g.keep && m.keep && !m.stale && oneLine(g.title) !== '') kept++;
    }
  }
  return { kept, total, stale };
}

/** "Add selected (4)" / "Move selected (6)", or plain when everything is kept. */
export function addLabel(p: AiProposal, r: Review): string {
  const { kept, total } = reviewCounts(r);
  const verb = p.kind === 'group' ? 'Move' : 'Add';
  return kept === total ? `${verb} all (${total})` : `${verb} selected (${kept})`;
}

const PROPOSED_FEATURE: Record<ProposedBy['feature'], string> = { generate: 'Generate ideas', summarise: 'Summarise', cluster: 'Cluster' };

/** The properties panel's line for an object an AI run proposed (already through cleanProposedBy): "Proposed by AI (Summarise) for Ana". */
export function proposedLine(p: ProposedBy | undefined): string | null {
  if (!p) return null;
  return `Proposed by AI (${PROPOSED_FEATURE[p.feature]})${p.by.name ? ` for ${p.by.name}` : ''}`;
}
