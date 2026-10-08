// Who sees and who settles a live AI run (docs/ai.md, "Live runs"). The rules live here and nowhere else on the server;
// src/ai-policy.ts is the same rules for the app's buttons, and test/ai-policy.test.ts keeps the two equal.
// Johan has still to decide the multiplayer details (TAB-141), so each choice is one constant.

/** Who sees the prompt of someone else's run: 'everyone', 'runner' (only the person who asked) or 'none'. */
export const PROMPT_VISIBILITY = 'runner';
/** Who may add or discard a ready run: 'editors' (anyone who can edit the board) or 'runner-first' (see below). */
export const RESOLVE_POLICY = 'editors';
/** With 'runner-first', other editors may settle a run this long after it is ready. */
export const RUNNER_FIRST_MS = 30_000;

const ROLES = new Set(['owner', 'editor', 'commenter', 'viewer']);
const EDIT_ROLES = new Set(['owner', 'editor']);

/** Anyone who can open the board sees its runs, viewers and commenters too. Open mode has no roles and passes 'owner'. */
export const canSeeRun = (role) => ROLES.has(role);

/**
 * Whether `viewer` may add or discard `run`. `canEdit` is the relay's own answer for the viewer (it is also false while
 * the workspace is read-only); `viewer.userId` is null in open mode, where nobody is the runner.
 * @param {{ role: string | null, userId: string | null, canEdit: boolean }} viewer
 * @param {{ status: string, by: { id: string | null }, readyAt: number | null }} run
 */
export function canResolve(viewer, run, now, policy = RESOLVE_POLICY) {
  if (run.status !== 'ready' || !viewer.canEdit || !EDIT_ROLES.has(viewer.role)) return false;
  if (policy === 'editors') return true;
  const mine = viewer.userId !== null && viewer.userId === run.by.id;
  return mine || (run.readyAt !== null && now - run.readyAt >= RUNNER_FIRST_MS);
}

/** Whether a broadcast to `viewer` carries the run's prompt. Under 'runner' it never does: the runner's app has it already. */
export const showsPrompt = (visibility = PROMPT_VISIBILITY) => visibility === 'everyone';
