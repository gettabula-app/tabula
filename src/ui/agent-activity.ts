import type { BoardApp } from '../app';
import { agentName } from '../app';
import { ApiError, api, type AgentActivityEntry } from '../api';
import { h } from './dom';
import { dialog, fmtAgo, toast } from './common';

/** Why a change cannot be reverted, as words. */
const WHY: Record<string, string> = { too_large: 'Too large to revert', expired: 'Too old to revert' };

/** What a revert left alone, as a sentence for the toast. */
export function revertMessage(result: { applied: number; skipped: { id: string; reason: string }[] }): string {
  const left = result.skipped.length;
  if (!result.applied) return left ? `Nothing was reverted: ${left} ${left === 1 ? 'object was' : 'objects were'} changed since or are in use.` : 'Nothing to revert.';
  return left ? `Reverted ${result.applied}, left ${left} that ${left === 1 ? 'was' : 'were'} changed since.` : `Reverted ${result.applied}.`;
}

/**
 * The Activity panel (TAB-158, docs/agent-presence.md): what each agent did on this board, newest first, in words with no content, and for editors a Revert that
 * takes one call back, leaving what people changed since. The names are text the server cleaned; they are set as text here, the token's own name quoted after
 * who the agent works for.
 */
export function openAgentActivity(app: BoardApp): void {
  const boardId = app.conn.id;
  const canRevert = !app.readOnly && (app.role === null || app.role === 'owner' || app.role === 'editor');
  const list = h('ul', { class: 'agent-activity', 'aria-label': 'Agent activity' });
  const status = h('p', { class: 'muted', role: 'status' }, 'Loading…');
  const body = h('div', { class: 'agent-activity-body' }, status, list);
  dialog('Agent activity', body, [{ label: 'Close', primary: true }], { className: 'agent-activity-dialog' });

  const row = (e: AgentActivityEntry) => {
    const who = agentName({ id: '', token: e.agent.token, member: e.agent.member, x: null, y: null });
    const where = e.ids.length ? h('button', { class: 'btn', onclick: () => { const b = app.r.contentBounds(e.ids); if (b) app.r.flyTo(b, 120, 3); } }, 'Go there') : null;
    let action: HTMLElement | null = null;
    if (e.reverted) action = h('span', { class: 'muted small' }, `Reverted${e.reverted.by ? ` by ${e.reverted.by}` : ''} ${fmtAgo(e.reverted.at)}`);
    else if (!e.revertible) action = h('span', { class: 'muted small' }, WHY[e.reason ?? ''] ?? 'Cannot be reverted');
    else if (canRevert) {
      const btn = h('button', { class: 'btn', onclick: async () => {
        btn.disabled = true;
        try {
          const result = await api.revertAgentActivity(boardId, e.id);
          toast(revertMessage(result));
        } catch (err) {
          toast(err instanceof ApiError && err.status === 409 ? 'This change was already reverted.' : err instanceof ApiError && err.status === 403 ? 'Only editors can revert an agent change.' : 'Could not revert that change.');
        }
        await load();
      } }, 'Revert');
      action = btn;
    }
    return h('li', { class: 'agent-activity-row' },
      h('div', { class: 'agent-activity-text' },
        h('strong', null, who), ' ', h('span', { class: 'agent-activity-token' }, `“${e.agent.token}”`), ' ', e.summary,
        h('span', { class: 'muted small' }, ` · ${fmtAgo(e.at)}`)),
      h('div', { class: 'agent-activity-actions' }, ...(where ? [where] : []), ...(action ? [action] : [])));
  };

  async function load() {
    try {
      const { entries } = await api.agentActivity(boardId);
      status.textContent = entries.length ? '' : 'No agent has changed this board in the last 7 days.';
      list.replaceChildren(...entries.map(row));
    } catch (err) {
      list.replaceChildren();
      status.textContent = err instanceof ApiError && (err.status === 404 || err.status === 403) ? 'Agent activity is kept for boards in a workspace with accounts.' : 'Could not load the agent activity.';
    }
  }
  void load();
}
