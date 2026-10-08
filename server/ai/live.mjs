// Live AI runs (docs/ai.md, "Live runs"): what everyone on a board sees while a run is going and until someone adds or
// discards its proposal. The state is in memory only. Nothing goes into the board document here: the person whose
// accept wins writes the proposal from their own app, as one undo step.
//
// The relay listens to onChange and sends each socket its own copy (viewFor, snapshotFor), so the rules of
// policy.mjs are applied per person on the server and never left to the app.

import crypto from 'node:crypto';
import { canSeeRun, showsPrompt } from './policy.mjs';

/** A ready run that nobody adds or discards goes away after this long. */
export const READY_TTL_MS = 10 * 60_000;
/** A run still marked running after this long has lost its stream (the provider call itself stops at two minutes). */
export const STALE_RUNNING_MS = 5 * 60_000;
/** A settled run is remembered this long, so a second add or discard is told it came too late. */
export const SETTLED_TTL_MS = 10 * 60_000;
/** Open runs per board; when a new one would pass it, the oldest ready run expires. */
export const MAX_RUNS_PER_BOARD = 12;

const OPEN = new Set(['running', 'ready']);

/**
 * @param {{ now?: () => number, newId?: () => string }} [deps]
 */
export function createLiveRuns({ now = Date.now, newId = () => crypto.randomBytes(9).toString('base64url') } = {}) {
  /** @type {Map<string, any>} every run by id, open and settled */
  const runs = new Map();
  /** @type {Set<(change: { boardId: string, run: any }) => void>} */
  const listeners = new Set();

  function emit(run) {
    for (const fn of listeners) {
      try {
        fn({ boardId: run.boardId, run });
      } catch (err) {
        console.error('ai: live listener failed:', err?.message ?? err);
      }
    }
  }

  function settle(run, status, extra = {}) {
    Object.assign(run, { status, settledAt: now(), proposal: null, prompt: null }, extra);
    emit(run);
  }

  /** Ends runs that waited too long and forgets settled ones. Every call below sweeps first; the relay also calls it on a timer. */
  function sweep() {
    const t = now();
    for (const run of runs.values()) {
      if (run.status === 'ready' && t - run.readyAt >= READY_TTL_MS) settle(run, 'expired');
      else if (run.status === 'running' && t - run.startedAt >= STALE_RUNNING_MS) settle(run, 'failed', { error: 'ai_timeout' });
      else if (!OPEN.has(run.status) && t - run.settledAt >= SETTLED_TTL_MS) runs.delete(run.id);
    }
  }

  const openRuns = (boardId) => [...runs.values()].filter((r) => r.boardId === boardId && OPEN.has(r.status));

  /**
   * A run has started. `by` is who is shown as the runner: `{ id, name, color }`; in open mode the id is null and the name
   * is what the person calls themselves (a client address is never shown to anyone). `target` is what the run reads, as
   * ids or a frame (each app outlines it from its own board), `private` hides the run from everyone but its runner. The caller has checked all of them.
   * Returns the run's id.
   * @param {string} boardId
   * @param {{ by?: { id: string | null, name: string | null, color?: string | null } | null, feature: string, prompt?: string | null,
   *   target?: { ids: string[] } | { frameId: string } | null, private?: boolean }} details
   */
  function start(boardId, { by, feature, prompt = null, target = null, private: hidden = false }) {
    sweep();
    const open = openRuns(boardId);
    if (open.length >= MAX_RUNS_PER_BOARD) {
      const oldest = open.filter((r) => r.status === 'ready').sort((a, b) => a.readyAt - b.readyAt)[0];
      if (oldest) settle(oldest, 'expired');
    }
    const run = {
      id: newId(),
      boardId,
      feature,
      by: { id: by?.id ?? null, name: by?.name ?? null, color: by?.color ?? null },
      target: target ? structuredClone(target) : null,
      private: hidden === true,
      prompt: typeof prompt === 'string' && prompt ? prompt : null,
      status: 'running',
      startedAt: now(),
      readyAt: null,
      settledAt: null,
      proposal: null,
      cut: false,
      error: null,
      resolvedBy: null,
    };
    runs.set(run.id, run);
    emit(run);
    return run.id;
  }

  /** The provider answered and the proposal passed validation. A run that is gone (its board unloaded) stays gone. */
  function ready(id, { proposal, cut = false }) {
    sweep();
    const run = runs.get(id);
    if (!run || run.status !== 'running') return;
    Object.assign(run, { status: 'ready', readyAt: now(), proposal, cut: Boolean(cut) });
    emit(run);
  }

  /** The run ended without a proposal. `code` is an AiError code, never a message. */
  function fail(id, code) {
    sweep();
    const run = runs.get(id);
    if (run?.status === 'running') settle(run, 'failed', { error: String(code) });
  }

  const get = (id) => {
    sweep();
    return runs.get(id) ?? null;
  };

  /**
   * Adds or discards a ready run, first come first served. The caller has checked canResolve. Returns the run with its
   * proposal for an accept (the caller hands it to the person who writes it), or why it could not.
   * @param {'accept' | 'discard'} action @param {{ id: string | null, name: string | null }} who
   * @returns {{ ok: true, run: any, proposal: any, cut: boolean } | { ok: false, reason: 'gone' | 'settled' | 'not_ready' }}
   */
  function resolve(id, action, who) {
    sweep();
    const run = runs.get(id);
    if (!run) return { ok: false, reason: 'gone' };
    if (run.status === 'running') return { ok: false, reason: 'not_ready' };
    if (run.status !== 'ready') return { ok: false, reason: 'settled' };
    const { proposal, cut } = run;
    settle(run, action === 'accept' ? 'accepted' : 'discarded', { resolvedBy: { id: who?.id ?? null, name: who?.name ?? null } });
    return { ok: true, run, proposal, cut };
  }

  /** The board's room unloaded: its runs end without a broadcast, since nobody is there to tell. */
  function dropBoard(boardId) {
    for (const run of runs.values()) if (run.boardId === boardId) runs.delete(run.id);
  }

  /**
   * What one person is sent about one run, or null when they may not see it.
   * @param {{ role: string | null, userId: string | null }} viewer
   */
  function viewFor(run, viewer) {
    if (!canSeeRun(viewer, run)) return null;
    const view = { id: run.id, feature: run.feature, status: run.status, by: { ...run.by } };
    if (run.private) view.private = true;
    if (run.status === 'running' || run.status === 'ready') Object.assign(view, { startedAt: run.startedAt, target: run.target ? structuredClone(run.target) : null });
    if (run.status === 'ready') Object.assign(view, { readyAt: run.readyAt, proposal: run.proposal, cut: run.cut });
    if (run.status === 'failed') view.error = run.error;
    if (run.resolvedBy) view.resolvedBy = { ...run.resolvedBy };
    if (run.prompt && OPEN.has(run.status) && showsPrompt()) view.prompt = run.prompt;
    return view;
  }

  /** The `{ kind: 'snapshot' }` message a person gets on joining a board, or null when they may not see its runs. */
  function snapshotFor(boardId, viewer) {
    sweep();
    if (!canSeeRun(viewer)) return null;
    return { kind: 'snapshot', runs: openRuns(boardId).map((run) => viewFor(run, viewer)).filter(Boolean) };
  }

  /** The `{ kind: 'patch' }` message about one change, or null. A settled status means the run is gone. */
  function patchFor(run, viewer) {
    const view = viewFor(run, viewer);
    return view ? { kind: 'patch', run: view } : null;
  }

  function onChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  return { start, ready, fail, get, resolve, dropBoard, sweep, viewFor, snapshotFor, patchFor, onChange, openRuns: (boardId) => (sweep(), openRuns(boardId)) };
}
