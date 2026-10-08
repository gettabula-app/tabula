// The rules of server/ai/policy.mjs for the app's buttons: who sees a live AI run and who may add or discard it. The
// server decides; this only hides what it would refuse. test/ai-policy.test.ts keeps the two files equal.

export type PromptVisibility = 'everyone' | 'runner' | 'none';
export type ResolvePolicy = 'editors' | 'runner-first';

export const PROMPT_VISIBILITY: PromptVisibility = 'runner';
export const RESOLVE_POLICY: ResolvePolicy = 'editors';
export const RUNNER_FIRST_MS = 30_000;

const ROLES = new Set(['owner', 'editor', 'commenter', 'viewer']);
const EDIT_ROLES = new Set(['owner', 'editor']);

export const canSeeRun = (role: string | null): boolean => role !== null && ROLES.has(role);

export interface PolicyViewer {
  role: string | null;
  userId: string | null;
  canEdit: boolean;
}

export interface PolicyRun {
  status: string;
  by: { id: string | null };
  readyAt: number | null;
}

export function canResolve(viewer: PolicyViewer, run: PolicyRun, now: number, policy: ResolvePolicy = RESOLVE_POLICY): boolean {
  if (run.status !== 'ready' || !viewer.canEdit || viewer.role === null || !EDIT_ROLES.has(viewer.role)) return false;
  if (policy === 'editors') return true;
  const mine = viewer.userId !== null && viewer.userId === run.by.id;
  return mine || (run.readyAt !== null && now - run.readyAt >= RUNNER_FIRST_MS);
}

export const showsPrompt = (visibility: PromptVisibility = PROMPT_VISIBILITY): boolean => visibility === 'everyone';
