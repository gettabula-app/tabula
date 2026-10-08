import './share.css';
import type { Me, Member, Share, ShareRole, Team, TeamMember } from '../api';
import { api } from '../api';
import { cachedServerBoards } from '../auth';
import { cloudErrorMessage } from '../cloud-logic';
import { toast } from './common';
import { h } from './dom';
import { DEFAULT_SHARE_ROLE, SHARE_ROLES, buildCandidates, shareRoleLabel, sortShares, type Candidate } from './share-logic';

interface Pool {
  teams: Team[];
  teamMembers: Record<string, TeamMember[]>;
  members: Member[] | null;
}

const errorText = (e: unknown) => cloudErrorMessage(e) ?? (e instanceof Error ? e.message : String(e));
const fail = (e: unknown) => toast(errorText(e));
const hintFor = (role: ShareRole) => SHARE_ROLES.find((r) => r.value === role)?.hint ?? '';

/** The people and teams with a role on this board, with a picker to give more. For board owners in accounts mode. */
export function mountSharePeople(boardId: string, me: Me): HTMLElement {
  const ownerId = cachedServerBoards().find((b) => b.id === boardId)?.ownerId ?? null;
  const seesMembers = me.user.role === 'owner' || me.user.role === 'admin';
  let shares: Share[] = [];
  let pool: Pool | null = null;
  let poolError: string | null = null;
  let poolLoad: Promise<void> | null = null;

  const list = h('div', null);
  const adder = h('div', null);
  const status = h('div', { class: 'share-status muted small', 'aria-live': 'polite' });
  const block = h('div', { class: 'share-people', role: 'group', 'aria-label': 'People with access' },
    h('div', { class: 'share-label' }, 'People with access'),
    list,
    adder,
    status,
  );

  const setStatus = (msg: string) => {
    status.textContent = msg;
  };

  const show = (...nodes: Node[]) => list.replaceChildren(...nodes);

  const renderList = () => {
    if (shares.length === 0) {
      show(h('div', { class: 'muted' }, 'Nobody has been given access to this board separately.'));
      return;
    }
    show(h('div', { class: 'share-list' }, ...sortShares(shares).map(row)));
  };

  const loadPool = async () => {
    poolError = null;
    renderAdd();
    try {
      const teams = await api.teams();
      const active = teams.filter((t) => !t.archived);
      const lists = await Promise.all(active.map((t) => api.teamMembers(t.id).catch((): TeamMember[] => [])));
      const teamMembers: Record<string, TeamMember[]> = {};
      active.forEach((t, i) => {
        teamMembers[t.id] = lists[i];
      });
      const members = seesMembers ? await api.members().catch(() => null) : null;
      pool = { teams, teamMembers, members };
    } catch (e) {
      poolError = errorText(e);
      poolLoad = null;
    }
    renderAdd();
  };

  const ensurePool = () => {
    poolLoad ??= loadPool();
  };

  const renderAdd = () => {
    if (!pool) {
      if (poolError === null) {
        adder.replaceChildren(h('div', { class: 'muted' }, 'Loading people…'));
      } else {
        adder.replaceChildren(h('div', { class: 'share-error', role: 'alert' },
          h('span', null, poolError),
          h('button', { class: 'btn', onclick: ensurePool }, 'Retry'),
        ));
      }
      return;
    }
    const input = { selfId: me.user.id, ownerId, ...pool };
    const candidates = buildCandidates({ ...input, shares });
    if (candidates.length === 0) {
      const nobody = buildCandidates({ ...input, shares: [] }).length === 0;
      adder.replaceChildren(h('div', { class: 'muted' },
        nobody ? 'There is nobody to add yet. Add people to a team first.' : 'Everyone you can share with already has access.'));
      return;
    }
    adderFor(candidates);
  };

  const adderFor = (candidates: Candidate[]) => {
    const picker: HTMLSelectElement = h('select', { class: 'input share-pick', 'aria-label': 'Person or team to add', onchange: () => {
      add.disabled = picker.value === '';
    } },
    h('option', { value: '', disabled: true, selected: true }, 'Add a person or team'),
    ...candidates.map((c, i) => h('option', { value: String(i) }, `${c.name}, ${c.detail}`)));
    const roleSelect: HTMLSelectElement = h('select', { class: 'input', 'aria-label': 'Role for the new person or team', onchange: () => {
      hint.textContent = hintFor(roleSelect.value as ShareRole);
    } }, ...SHARE_ROLES.map((r) => h('option', { value: r.value, selected: r.value === DEFAULT_SHARE_ROLE }, r.label)));
    const hint = h('div', { class: 'share-hint muted small' }, hintFor(DEFAULT_SHARE_ROLE));
    const add: HTMLButtonElement = h('button', { class: 'btn', disabled: true, onclick: async () => {
      const c = picker.value === '' ? undefined : candidates[Number(picker.value)];
      if (!c) return;
      const role = roleSelect.value as ShareRole;
      add.disabled = true;
      try {
        await api.share(boardId, { principalType: c.type, principalId: c.id, role });
      } catch (e) {
        fail(e);
        add.disabled = picker.value === '';
        return;
      }
      shares = [...shares, { principalType: c.type, principalId: c.id, name: c.name, role }];
      renderList();
      renderAdd();
      setStatus(`Added ${c.name} as ${shareRoleLabel(role)}`);
    } }, 'Add');
    adder.replaceChildren(h('div', { class: 'share-add' }, picker, roleSelect, add, hint));
  };

  const row = (s: Share): HTMLElement => {
    const roleSelect: HTMLSelectElement = h('select', { class: 'input', 'aria-label': `Role for ${s.name}`, onchange: async (e: Event) => {
      const el = e.currentTarget as HTMLSelectElement;
      const next = el.value as ShareRole;
      try {
        await api.share(boardId, { principalType: s.principalType, principalId: s.principalId, role: next });
      } catch (err) {
        fail(err);
        el.value = s.role;
        return;
      }
      s.role = next;
      setStatus(`Role saved: ${shareRoleLabel(next)}`);
    } }, ...SHARE_ROLES.map((r) => h('option', { value: r.value, selected: r.value === s.role }, r.label)));
    let armed = false;
    const remove: HTMLButtonElement = h('button', { class: 'btn', onclick: async () => {
      if (!armed) {
        armed = true;
        remove.textContent = 'Click again';
        remove.classList.add('armed');
        return;
      }
      remove.disabled = true;
      try {
        await api.unshare(boardId, s.principalType, s.principalId);
      } catch (e) {
        fail(e);
        armed = false;
        remove.textContent = 'Remove';
        remove.classList.remove('armed');
        remove.disabled = false;
        return;
      }
      shares = shares.filter((x) => !(x.principalType === s.principalType && x.principalId === s.principalId));
      renderList();
      renderAdd();
      setStatus(`Removed ${s.name}`);
    } }, 'Remove');
    return h('div', { class: 'share-row' },
      h('div', { class: 'share-who' },
        h('div', { class: 'share-name' }, s.name),
        h('div', { class: 'share-kind' }, s.principalType === 'team' ? 'Team' : 'Person'),
      ),
      h('div', { class: 'share-controls' }, roleSelect, remove),
    );
  };

  const load = async () => {
    show(h('div', { class: 'muted' }, 'Loading…'));
    try {
      shares = await api.shares(boardId);
    } catch (e) {
      show(h('div', { class: 'share-error', role: 'alert' },
        h('span', null, errorText(e)),
        h('button', { class: 'btn', onclick: () => void load() }, 'Retry'),
      ));
      return;
    }
    renderList();
    renderAdd();
    ensurePool();
  };

  void load();
  return block;
}
