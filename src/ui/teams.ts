import './teams.css';
import type { CreatedInvite, Invite, Me, Member, Team, TeamMember, TeamRole, UserRole } from '../api';
import { ApiError, api } from '../api';
import { cloudErrorMessage } from '../cloud-logic';
import { dialog, field, segmented, toast } from './common';
import { h, icon } from './dom';

const ROLE_NAMES: Record<UserRole, string> = { owner: 'Owner', admin: 'Admin', member: 'Member', guest: 'Guest' };
const TEAM_ROLE_NAMES: Record<TeamRole, string> = { admin: 'Admin', member: 'Member' };

function fail(e: unknown) {
  toast(cloudErrorMessage(e) ?? (e instanceof Error ? e.message : String(e)));
}

const fmtDate = (t: number) => new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

/** Dialog to create a team. Calls onDone with the new team. */
export function openCreateTeam(onDone: (team: Team) => void): void {
  const name = h('input', { class: 'input', maxlength: 80, required: true, 'aria-label': 'Team name' });
  let busy = false;
  const submit = async () => {
    const value = name.value.trim();
    if (!value) {
      toast('Give the team a name.');
      return;
    }
    if (busy) return;
    busy = true;
    try {
      const team = await api.createTeam(value);
      dlg.close();
      onDone(team);
    } catch (e) {
      fail(e);
    } finally {
      busy = false;
    }
  };
  const form = h('form', { noValidate: true, onsubmit: (e: Event) => { e.preventDefault(); void submit(); } }, field('Team name', name));
  const dlg = dialog('New team', form, [
    { label: 'Cancel' },
    { label: 'Create team', primary: true, onClick: async () => { await submit(); return false; } },
  ]);
}

/** Team settings: rename, members and roles, invite link, leave. onChange fires after any change. */
export function openTeamManager(team: Team, me: Me, onChange: () => void): void {
  const canAdmin = team.role === 'admin' || ['owner', 'admin'].includes(me.user.role);
  const membersBox = h('div', null, h('p', { class: 'muted' }, 'Loading…'));
  const invitesBox = h('div', null);
  const inviteResult = h('div', { class: 'field' });
  let inviteRole: TeamRole = 'member';

  const loadMembers = () => api.teamMembers(team.id).then(
    (list) => membersBox.replaceChildren(...(list.length ? list.map(memberRow) : [h('p', { class: 'muted' }, 'No members.')])),
    fail,
  );

  const confirmLeave = () => {
    dialog(`Leave ${team.name}?`, h('p', null, 'You lose access to this team’s boards. Boards shared with you directly stay shared.'), [
      { label: 'Cancel' },
      { label: 'Leave team', primary: true, onClick: async () => {
        try {
          await api.removeTeamMember(team.id, me.user.id);
        } catch (e) {
          if (e instanceof ApiError && e.status === 409) {
            toast('You are the last admin. Make someone else an admin first.');
          } else {
            fail(e);
          }
          return false;
        }
        dlg.close();
        onChange();
      } },
    ]);
  };

  const removeButton = (m: TeamMember) => h('button', { class: 'icon-btn danger', title: 'Remove from team', 'aria-label': `Remove ${m.name}`, onclick: () => {
    dialog(`Remove ${m.name}?`, h('p', null, `${m.name} loses access to this team’s boards. Boards shared with them directly stay shared.`), [
      { label: 'Cancel' },
      { label: 'Remove', primary: true, onClick: async () => {
        try {
          await api.removeTeamMember(team.id, m.userId);
        } catch (e) {
          fail(e);
          return false;
        }
        void loadMembers();
        onChange();
      } },
    ]);
  } }, icon('trash', 18));

  const roleSelect = (m: TeamMember) => h('select', { class: 'input', 'aria-label': `Role of ${m.name}`, onchange: async (e: Event) => {
    const el = e.currentTarget as HTMLSelectElement;
    try {
      await api.setTeamRole(team.id, m.userId, el.value as TeamRole);
    } catch (err) {
      fail(err);
      el.value = m.role;
      return;
    }
    void loadMembers();
    onChange();
  } }, ...(['admin', 'member'] as const).map((r) => h('option', { value: r, selected: r === m.role }, TEAM_ROLE_NAMES[r])));

  const memberRow = (m: TeamMember) => {
    const mine = m.userId === me.user.id;
    const who = h('div', { class: 'who' },
      h('div', null, m.name, mine ? h('span', { class: 'muted' }, ' · You') : null),
      h('div', { class: 'muted' }, m.email),
    );
    const roleCell = canAdmin ? roleSelect(m) : h('span', { class: 'muted' }, TEAM_ROLE_NAMES[m.role]);
    const action = mine ? h('button', { class: 'btn', onclick: confirmLeave }, 'Leave team') : canAdmin ? removeButton(m) : null;
    return h('div', { class: 'member-row' }, who, roleCell, action);
  };

  const nameInput = h('input', { class: 'input', value: team.name, maxlength: 80, 'aria-label': 'Team name' });
  const rename = async () => {
    const name = nameInput.value.trim();
    if (!name) {
      toast('Give the team a name.');
      return;
    }
    try {
      await api.updateTeam(team.id, { name });
    } catch (e) {
      fail(e);
      return;
    }
    dlg.box.setAttribute('aria-label', name);
    dlg.box.querySelector('h2')?.replaceChildren(name);
    toast('Team renamed');
    onChange();
  };

  const loadInvites = () => api.listInvites(team.id).then(
    (list) => invitesBox.replaceChildren(...(list.length ? list.map(inviteRow) : [h('p', { class: 'muted' }, 'No active invite links.')])),
    fail,
  );

  const inviteRow = (i: Invite) => h('div', { class: 'member-row' },
    h('div', { class: 'who' },
      h('div', null, `Join as ${i.role}`),
      h('div', { class: 'muted' }, `expires ${fmtDate(i.expiresAt)} · ${i.uses} ${i.uses === 1 ? 'use' : 'uses'}`),
    ),
    h('button', { class: 'btn', onclick: async () => {
      try {
        await api.revokeInvite(team.id, i.id);
      } catch (e) {
        fail(e);
        return;
      }
      void loadInvites();
    } }, 'Revoke'),
  );

  const inviteLink = (created: CreatedInvite, role: TeamRole) => {
    const url = h('input', { class: 'input', value: created.url, readOnly: true, 'aria-label': 'Invite link' });
    const copy = async () => {
      try {
        await navigator.clipboard.writeText(created.url);
        toast('Link copied');
      } catch {
        url.focus();
        url.select();
      }
    };
    return h('div', null,
      h('div', { class: 'invite-url' }, url, h('button', { class: 'btn', onclick: copy }, icon('copy', 16), 'Copy')),
      h('p', { class: 'muted' }, `Anyone with this link who confirms their email can join as ${role}. It expires on ${fmtDate(created.expiresAt)}.`),
    );
  };

  const roleToggle = segmented<TeamRole>([{ value: 'member', label: 'Member' }, { value: 'admin', label: 'Admin' }], inviteRole, (v) => { inviteRole = v; }, 'Invite role');
  const days = h('select', { class: 'input', 'aria-label': 'Link expires after' },
    ...[1, 7, 14, 30].map((d) => h('option', { value: String(d), selected: d === 7 }, d === 1 ? '1 day' : `${d} days`)));
  const createLink = async () => {
    const role = inviteRole;
    try {
      const created = await api.createInvite(team.id, { role, days: Number(days.value) });
      inviteResult.replaceChildren(inviteLink(created, role));
      void loadInvites();
    } catch (e) {
      fail(e);
    }
  };

  const confirmArchive = () => {
    dialog('Archive this team?', h('p', null, 'Its boards stay available to the people who had access, but the team disappears from the home screen.'), [
      { label: 'Cancel' },
      { label: 'Archive team', primary: true, onClick: async () => {
        try {
          await api.updateTeam(team.id, { archived: true });
        } catch (e) {
          fail(e);
          return false;
        }
        dlg.close();
        onChange();
      } },
    ]);
  };

  const sections: HTMLElement[] = [];
  if (canAdmin) {
    sections.push(h('div', { class: 'team-section' },
      h('div', { class: 'list-label' }, 'Name'),
      h('form', { class: 'copy-row', noValidate: true, onsubmit: (e: Event) => { e.preventDefault(); void rename(); } },
        nameInput, h('button', { class: 'btn', type: 'submit' }, 'Save')),
    ));
  }
  sections.push(h('div', { class: 'team-section' }, h('div', { class: 'list-label' }, 'Members'), membersBox));
  if (canAdmin) {
    sections.push(h('div', { class: 'team-section' },
      h('div', { class: 'list-label' }, 'Invite link'),
      h('div', { class: 'row2' }, field('Role', roleToggle), field('Expires after', days)),
      h('div', { class: 'field' }, h('button', { class: 'btn', onclick: createLink }, 'Create invite link')),
      inviteResult,
      h('div', { class: 'field' }, h('div', { class: 'field-label' }, 'Active links'), invitesBox),
    ));
    sections.push(h('div', { class: 'team-section danger-zone' },
      h('div', { class: 'list-label' }, 'Danger zone'),
      h('button', { class: 'btn', onclick: confirmArchive }, 'Archive team'),
    ));
  }

  const dlg = dialog(team.name, h('div', null, ...sections));
  void loadMembers();
  if (canAdmin) void loadInvites();
}

/** Workspace members and roles, for owners and admins. */
export function openWorkspaceMembers(me: Me, onChange: () => void): void {
  if (me.user.role !== 'owner' && me.user.role !== 'admin') {
    toast('Only workspace admins can manage members.');
    return;
  }
  const isOwner = me.user.role === 'owner';
  const box = h('div', null, h('p', { class: 'muted' }, 'Loading…'));

  const load = () => api.members().then((list) => {
    const owners = list.filter((m) => m.role === 'owner').length;
    box.replaceChildren(...list.map((m) => memberRow(m, owners)));
  }, fail);

  const confirmRemove = (m: Member) => {
    dialog(`Remove ${m.name}?`, h('p', null, `${m.name} is signed out everywhere and loses access immediately. Their local copies stay on their devices.`), [
      { label: 'Cancel' },
      { label: 'Remove member', primary: true, onClick: async () => {
        try {
          await api.removeMember(m.id);
        } catch (e) {
          fail(e);
          return false;
        }
        void load();
        onChange();
      } },
    ]);
  };

  const memberRow = (m: Member, owners: number) => {
    const mine = m.id === me.user.id;
    const locked = mine || (m.role === 'owner' && (!isOwner || owners === 1));
    const roles: UserRole[] = m.role === 'owner' && !isOwner
      ? ['owner']
      : isOwner ? ['owner', 'admin', 'member', 'guest'] : ['admin', 'member', 'guest'];
    const role = h('select', { class: 'input', 'aria-label': `Workspace role of ${m.name}`, disabled: locked, onchange: async (e: Event) => {
      const el = e.currentTarget as HTMLSelectElement;
      try {
        await api.updateMember(m.id, { role: el.value as UserRole });
      } catch (err) {
        fail(err);
        el.value = m.role;
        return;
      }
      void load();
      onChange();
    } }, ...roles.map((r) => h('option', { value: r, selected: r === m.role }, ROLE_NAMES[r])));
    const who = h('div', { class: 'who' },
      h('div', null, m.disabled ? h('span', { class: 'badge-off' }, 'Disabled') : null, m.name, mine ? h('span', { class: 'muted' }, ' · You') : null),
      h('div', { class: 'muted' }, m.email),
      h('div', { class: 'muted' }, m.teams.length ? m.teams.map((t) => t.name).join(', ') : 'No teams'),
    );
    if (mine) return h('div', { class: 'member-row' }, who, role);
    const toggle = h('button', { class: 'btn', onclick: async () => {
      try {
        await api.updateMember(m.id, { disabled: !m.disabled });
      } catch (e) {
        fail(e);
        return;
      }
      void load();
      onChange();
    } }, m.disabled ? 'Enable' : 'Disable');
    const remove = h('button', { class: 'icon-btn danger', title: 'Remove from workspace', 'aria-label': `Remove ${m.name}`, onclick: () => confirmRemove(m) }, icon('trash', 18));
    return h('div', { class: 'member-row' }, who, role, h('div', { class: 'btn-row' }, toggle, remove));
  };

  dialog('Workspace members', box);
  void load();
}
