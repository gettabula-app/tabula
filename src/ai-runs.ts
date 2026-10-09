import type { AiFeature } from './api';
import type { AiRunsMessage } from './sync';
import { isProposal } from './ai-bar-logic';
import { layoutProposal, type AiProposal, type Existing, type Layout, type Rect } from './ai-apply';

// The board's live AI runs as the relay tells them (docs/ai.md, "Live runs"; message type 6): a snapshot on joining, then
// a patch per change. Everything that arrives is checked here, because it is drawn on the canvas. Pure: no DOM.

export interface RunPerson { id: string | null; name: string | null; color: string | null }
export type RunTarget = { ids: string[] } | { frameId: string } | null;

export interface LiveRun {
  id: string;
  feature: AiFeature;
  status: 'running' | 'ready';
  by: RunPerson;
  private: boolean;
  startedAt: number;
  readyAt: number | null;
  target: RunTarget;
  proposal: AiProposal | null;
  cut: boolean;
}

export interface SettledRun {
  id: string;
  feature: AiFeature;
  status: 'accepted' | 'discarded' | 'failed' | 'expired';
  by: RunPerson;
  resolvedBy: { id: string | null; name: string | null } | null;
  error: string | null;
}

const FEATURES = new Set<AiFeature>(['generate', 'summarise', 'cluster']);
const SETTLED = new Set(['accepted', 'discarded', 'failed', 'expired']);
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const NAME_MAX = 40;
const MAX_TARGET_IDS = 400;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const idOf = (v: unknown): string | null => (typeof v === 'string' && ID_RE.test(v) ? v : null);
const time = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** A name as plain text of at most 40 characters, or null. Control and invisible characters go. */
export function cleanName(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  let kept = '';
  for (const ch of v) if (!isHiddenChar(ch.codePointAt(0)!)) kept += ch;
  const cut = [...kept.replace(/\s+/g, ' ').trim()].slice(0, NAME_MAX).join('').trim();
  return cut || null;
}

/** Control characters (line breaks become spaces), zero-width, bidirectional and tag characters. */
function isHiddenChar(cp: number): boolean {
  if (cp === 0x0a || cp === 0x0d || cp === 0x09) return false;
  return cp < 0x20 || (cp >= 0x7f && cp <= 0x9f) || (cp >= 0x200b && cp <= 0x200f) || (cp >= 0x2028 && cp <= 0x202e) ||
    (cp >= 0x2060 && cp <= 0x2069) || cp === 0xfeff || (cp >= 0xe0000 && cp <= 0xe007f);
}

function person(v: unknown): RunPerson {
  const p = isRecord(v) ? v : {};
  return { id: typeof p.id === 'string' ? p.id : null, name: cleanName(p.name), color: typeof p.color === 'string' && COLOR_RE.test(p.color) ? p.color.toUpperCase() : null };
}

function target(v: unknown): RunTarget {
  if (!isRecord(v)) return null;
  if (Array.isArray(v.ids)) {
    const ids = v.ids.map(idOf).filter((x): x is string => x !== null).slice(0, MAX_TARGET_IDS);
    return ids.length ? { ids } : null;
  }
  const frameId = idOf(v.frameId);
  return frameId ? { frameId } : null;
}

/** One run as the relay sent it, checked: an open run, a settled one, or null for something unreadable. */
export function parseRun(v: unknown): LiveRun | SettledRun | null {
  if (!isRecord(v)) return null;
  const id = idOf(v.id);
  const feature = v.feature as AiFeature;
  if (!id || !FEATURES.has(feature) || typeof v.status !== 'string') return null;
  if (SETTLED.has(v.status)) {
    const rb = isRecord(v.resolvedBy) ? { id: typeof v.resolvedBy.id === 'string' ? v.resolvedBy.id : null, name: cleanName(v.resolvedBy.name) } : null;
    return { id, feature, status: v.status as SettledRun['status'], by: person(v.by), resolvedBy: rb, error: typeof v.error === 'string' ? v.error.slice(0, 40) : null };
  }
  if (v.status !== 'running' && v.status !== 'ready') return null;
  const proposal = v.status === 'ready' ? (isProposal(v.proposal) ? v.proposal : null) : null;
  if (v.status === 'ready' && !proposal) return null;
  return {
    id,
    feature,
    status: v.status,
    by: person(v.by),
    private: v.private === true,
    startedAt: time(v.startedAt) ?? 0,
    readyAt: v.status === 'ready' ? time(v.readyAt) : null,
    target: target(v.target),
    proposal,
    cut: v.cut === true,
  };
}

const isOpen = (r: LiveRun | SettledRun): r is LiveRun => r.status === 'running' || r.status === 'ready';

/** Oldest first, ties by id: the order every app stacks and lays out previews in. */
export const byStart = (a: LiveRun, b: LiveRun): number => a.startedAt - b.startedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** The open runs of one board. `apply` takes a relay message and returns the runs it settled, for toasts. */
export class LiveRuns {
  private runs = new Map<string, LiveRun>();
  private listeners = new Set<() => void>();

  apply(message: AiRunsMessage): SettledRun[] {
    const settled: SettledRun[] = [];
    if (message.kind === 'snapshot') {
      this.runs.clear();
      for (const raw of message.runs) {
        const run = parseRun(raw);
        if (run && isOpen(run)) this.runs.set(run.id, run);
      }
    } else {
      const run = parseRun(message.run);
      if (!run) return settled;
      if (isOpen(run)) this.runs.set(run.id, run);
      else if (this.runs.delete(run.id) || run.status === 'failed') settled.push(run);
    }
    this.emit();
    return settled;
  }

  /** Forgets a run at once (the person's own add or discard was answered), before the relay's patch arrives. */
  drop(id: string): void {
    if (this.runs.delete(id)) this.emit();
  }

  clear(): void {
    if (!this.runs.size) return;
    this.runs.clear();
    this.emit();
  }

  get(id: string): LiveRun | undefined {
    return this.runs.get(id);
  }

  list(): LiveRun[] {
    return [...this.runs.values()].sort(byStart);
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    for (const fn of this.listeners) {
      try {
        fn();
      } catch {
        /* a failing listener must not stop the others */
      }
    }
  }
}

/**
 * Where each ready run's proposal goes, in stacking order (oldest first): each one right of the board and of the areas
 * laid out before it, so previews never land on each other. A run whose proposal no longer fits the board is left out.
 * Adding run X uses `avoidFor(X)`, the areas before it, so what is previewed is what is added.
 */
export function previewLayouts(runs: readonly LiveRun[], board: { content: Rect | null; get: (id: string) => Existing | undefined }): Map<string, Layout> {
  const out = new Map<string, Layout>();
  const placed: Rect[] = [];
  for (const run of [...runs].sort(byStart)) {
    if (run.status !== 'ready' || !run.proposal) continue;
    const layout = layoutProposal(run.proposal, board, placed);
    if (!layout) continue;
    out.set(run.id, layout);
    // a group moves stickies already on the board, so only a create claims new space
    if (layout.kind === 'create') placed.push(layout.area);
  }
  return out;
}

/** The areas laid out before `id`: what adding it must avoid to land where its preview is. */
export function avoidFor(id: string, runs: readonly LiveRun[], layouts: Map<string, Layout>): Rect[] {
  const out: Rect[] = [];
  for (const run of [...runs].sort(byStart)) {
    if (run.id === id) break;
    const l = layouts.get(run.id);
    if (l?.kind === 'create') out.push(l.area);
  }
  return out;
}

/** The person's words for a run in flight: "Ana is asking AI: Summarise…". The prompt is never shown. */
export function presenceLine(run: Pick<LiveRun, 'by' | 'feature'>): string {
  const what = { summarise: 'Summarise', cluster: 'Cluster', generate: 'Generate ideas' }[run.feature];
  return `${run.by.name ?? 'Someone'} is asking AI: ${what}…`;
}

/** "Ana's AI preview", or "Your AI preview" for the person's own run. */
export function previewLabel(run: Pick<LiveRun, 'by'>, mine: boolean): string {
  return mine ? 'Your AI preview' : `${run.by.name ?? 'Someone'}'s AI preview`;
}
