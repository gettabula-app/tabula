import type { Store } from './store';
import type { Id, Obj } from './types';

/** Origin of preview writes. The undo manager tracks only local writes, so previews never reach the undo history. */
export const PREVIEW = 'preview';

export type Patch = Record<string, unknown>;

/** Writes `patch` to one object; the caller may add derived fields (a text box's height). Runs inside a transaction. */
export type WriteFn = (o: Obj, patch: Patch) => void;

/**
 * Live style edits from the properties panel: hovering an option, scrolling a number field, holding an arrow key.
 * Each step is written at once, so the board (and everyone on it) shows it, but outside the undo history. The edit
 * then either commits, which puts the objects back as they were and writes the final value as one ordinary change
 * (one undo entry, undoing to the values before the preview), or reverts, which puts them back.
 */
export class StyleEdit {
  /** Values of the touched keys before the first preview, per object; its keys are the objects being edited. */
  private originals: Map<Id, Patch> | null = null;
  private last: { patch: Patch; filter?: (o: Obj) => boolean } | null = null;
  private listeners = new Set<() => void>();

  constructor(
    private store: Store,
    private targets: () => Obj[],
    private write: WriteFn,
  ) {}

  /** A preview is showing (the panel should not rebuild under it). */
  get active(): boolean {
    return this.originals !== null;
  }

  onEnd(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Shows `patch` on the targets without recording it. Later previews replace earlier ones. */
  preview(patch: Patch, filter?: (o: Obj) => boolean) {
    if (this.store.readOnly) return;
    // a preview stays on the objects it started on, even if the selection changes under it
    const targets = (this.originals ? this.pinned() : this.targets()).filter((o) => !filter || filter(o));
    if (!targets.length) return;
    const originals = this.originals ?? new Map<Id, Patch>();
    this.store.transactAs(() => {
      for (const o of targets) {
        const before = this.store.objects.get(o.id);
        if (!before) continue;
        const saved = originals.get(o.id) ?? {};
        // remember each key the first time any preview changes it, including the derived ones `write` sets
        const snapshot = before.toJSON() as Patch;
        this.write(this.store.get(o.id) ?? o, patch);
        const after = before.toJSON() as Patch;
        for (const k of new Set([...Object.keys(patch), ...Object.keys(snapshot), ...Object.keys(after)])) {
          if (k === 'updatedAt' || k in saved) continue;
          if (k in patch || JSON.stringify(snapshot[k]) !== JSON.stringify(after[k])) saved[k] = snapshot[k];
        }
        originals.set(o.id, saved);
      }
    }, PREVIEW);
    this.originals = originals;
    this.last = { patch, filter };
  }

  /** Keeps the latest preview, if any (the control that showed it is going away). */
  settle() {
    if (this.originals && this.last) this.commit(this.last.patch, this.last.filter);
  }

  private pinned(): Obj[] {
    return [...this.originals!.keys()].map((id) => this.store.get(id)).filter((o): o is Obj => !!o);
  }

  /** Puts the targets back as they were before the first preview. */
  revert() {
    if (!this.originals) return;
    this.restore();
    this.finish();
  }

  /** Writes `patch` as one undoable change, undoing to the values from before any preview. */
  commit(patch: Patch, filter?: (o: Obj) => boolean) {
    const targets = this.originals ? this.pinned() : this.targets();
    if (this.originals) this.restore();
    this.originals = null;
    if (!this.store.readOnly) {
      this.store.undo.stopCapturing();
      this.store.transact(() => {
        for (const o of targets) {
          if (filter && !filter(o)) continue;
          const cur = this.store.get(o.id);
          if (cur) this.write(cur, patch);
        }
      });
      this.store.undo.stopCapturing();
    }
    this.finish();
  }

  private restore() {
    const originals = this.originals!;
    this.store.transactAs(() => {
      for (const [id, saved] of originals) this.store.update(id, saved);
    }, PREVIEW);
  }

  private finish() {
    this.originals = null;
    this.last = null;
    this.listeners.forEach((fn) => fn());
  }
}

export interface StepOptions {
  min: number;
  max: number;
  /** One step: arrow keys, one notch of the wheel. */
  step: number;
  /** A step with Shift held. */
  big: number;
}

/** The next value of a number field: `dir` steps up (1) or down (-1), snapped to the step and clamped. */
export function stepValue(value: number, dir: number, o: StepOptions, shift = false): number {
  const by = shift ? o.big : o.step;
  const next = dir > 0 ? Math.floor(value / by) * by + by : Math.ceil(value / by) * by - by;
  return clampValue(next, o);
}

export function clampValue(value: number, o: Pick<StepOptions, 'min' | 'max'>): number {
  return Math.min(o.max, Math.max(o.min, value));
}

/** A typed value: digits with an optional decimal and unit; null when there is no number in it. */
export function parseTyped(text: string): number | null {
  const m = /-?\d+(\.\d+)?/.exec(text.replace(',', '.'));
  return m ? Number(m[0]) : null;
}

/**
 * Turns wheel deltas into whole steps. A mouse wheel click is one step (browsers report it as one large delta, or
 * one line); a trackpad sends many small deltas, which add up until they reach one notch. Returns the number of
 * steps to take (positive is up, so scrolling up raises).
 */
export class WheelSteps {
  private acc = 0;
  constructor(private notch = 40) {}
  add(deltaY: number, deltaMode = 0): number {
    if (deltaMode !== 0 || Math.abs(deltaY) >= 50) {
      this.acc = 0;
      return deltaY < 0 ? 1 : deltaY > 0 ? -1 : 0;
    }
    const px = deltaY;
    this.acc -= px;
    const steps = Math.trunc(this.acc / this.notch);
    this.acc -= steps * this.notch;
    return steps;
  }
  reset() {
    this.acc = 0;
  }
}
