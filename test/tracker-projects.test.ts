import { afterEach, describe, expect, it } from 'vitest';
import { openDirectory } from '../server/directory.mjs';
import { OpsError } from '../server/board-ops.mjs';
import {
  archiveMilestone, archiveProject, createMilestone, createProject, listMilestones, listProjects, restoreMilestone,
  restoreProject, updateMilestone, updateProject,
} from '../server/tracker/projects.mjs';
import { createTicket, getTicket, updateTicket } from '../server/tracker/tickets.mjs';

const opened: any[] = [];
const open = () => {
  const directory: any = openDirectory(':memory:');
  opened.push(directory);
  return directory;
};
function fixture() {
  const directory = open();
  const owner = directory.createUser({ email: 'owner@example.com', name: 'Owner', role: 'owner' });
  const member = directory.createUser({ email: 'ada@example.com', name: 'Ada Lovelace', role: 'member' });
  return { directory, owner, member, actor: { id: owner.id, role: owner.role, name: owner.name } };
}
function caught(run: () => unknown) {
  try { run(); } catch (error) { return error as OpsError; }
  throw new Error('expected an OpsError');
}
function expectCode(run: () => unknown, code: string) {
  const error = caught(run);
  expect(error).toBeInstanceOf(OpsError);
  expect(error.code).toBe(code);
  return error;
}

afterEach(() => {
  for (const directory of opened.splice(0)) directory.close();
});

describe('tracker projects and milestones', () => {
  it('resolves project owners by member name or email and rejects raw user ids', () => {
    const { directory, owner, member, actor } = fixture();
    const byName = createProject({ directory, actor, name: 'Roadmap', owner: 'Ada Lovelace', now: 10 });
    const byEmail = createProject({ directory, actor, name: 'Infrastructure', owner: 'ada@example.com', now: 11 });
    expect(byName.owner).toEqual({ userId: member.id, name: member.name });
    expect(byEmail.owner?.userId).toBe(member.id);
    expectCode(() => createProject({ directory, actor, name: 'Raw id', owner: member.id }), 'invalid_input');
    expect(createProject({ directory, actor, name: 'Self owner', owner: 'me' }).owner?.userId).toBe(owner.id);
  });

  it('enforces case-insensitive active names, state, restore conflicts, and list filtering', () => {
    const { directory, actor } = fixture();
    const project = createProject({ directory, actor, name: 'Roadmap', state: 'started', description: '**Plan**', now: 1 });
    expect(project).toMatchObject({ name: 'Roadmap', state: 'started', description: '**Plan**', archivedAt: null });
    expectCode(() => createProject({ directory, actor, name: 'roadMAP' }), 'conflict');
    const renamed = updateProject({ directory, actor, projectId: project.id, patch: { name: 'Release plan', state: 'paused' }, now: 2 });
    expect(renamed).toMatchObject({ name: 'Release plan', state: 'paused', updatedAt: 2 });
    archiveProject({ directory, actor, projectId: project.id, now: 3 });
    const replacement = createProject({ directory, actor, name: 'Release plan' });
    expect(listProjects({ directory, actor }).map((item: any) => item.id)).toEqual([replacement.id]);
    expect(listProjects({ directory, actor, includeArchived: true })).toHaveLength(2);
    expectCode(() => restoreProject({ directory, actor, projectId: project.id }), 'conflict');
    archiveProject({ directory, actor, projectId: replacement.id });
    expect(restoreProject({ directory, actor, projectId: project.id }).archivedAt).toBeNull();
    expectCode(() => createProject({ directory, actor, name: 'Invalid state', state: 'finished' as any }), 'invalid_input');
    expectCode(() => updateProject({ directory, actor, projectId: project.id, patch: { description: 'x'.repeat(20_001) } }), 'invalid_input');
  });

  it('caps active projects and restores without deleting archived rows', () => {
    const { directory, actor } = fixture();
    for (let index = 0; index < 200; index++) createProject({ directory, actor, name: `Project ${index}` });
    expectCode(() => createProject({ directory, actor, name: 'Project 200' }), 'limit_exceeded');
    const first = listProjects({ directory, actor })[0];
    archiveProject({ directory, actor, projectId: first.id });
    expect(createProject({ directory, actor, name: first.name }).name).toBe(first.name);
    expect(directory.db.prepare('SELECT COUNT(*) AS n FROM projects').get().n).toBe(201);
  });

  it('guards project and milestone writes before touching rows and rejects tracker viewers', () => {
    const { directory, owner, actor } = fixture();
    const project = createProject({ directory, actor, name: 'Guarded' });
    const milestone = createMilestone({ directory, actor, projectId: project.id, name: 'Guarded milestone', due: '2026-12-01' });
    const before = {
      projects: directory.db.prepare('SELECT COUNT(*) AS n FROM projects').get().n,
      milestones: directory.db.prepare('SELECT COUNT(*) AS n FROM milestones').get().n,
    };
    const readOnly = () => true;
    expectCode(() => createProject({ directory, actor, name: 'Blocked', readOnly }), 'read_only');
    expectCode(() => updateProject({ directory, actor, projectId: project.id, patch: { name: 'Blocked' }, readOnly }), 'read_only');
    expectCode(() => createMilestone({ directory, actor, projectId: project.id, name: 'Blocked', due: '2026-12-02', readOnly }), 'read_only');
    expectCode(() => updateMilestone({ directory, actor, milestoneId: milestone.id, patch: { name: 'Blocked' }, readOnly }), 'read_only');
    const viewer = { id: owner.id, workspaceRole: 'viewer' };
    expectCode(() => createProject({ directory, actor: viewer, name: 'Forbidden' }), 'forbidden');
    expect(directory.db.prepare('SELECT COUNT(*) AS n FROM projects').get().n).toBe(before.projects);
    expect(directory.db.prepare('SELECT COUNT(*) AS n FROM milestones').get().n).toBe(before.milestones);
  });

  it('requires an active project, a valid due date, and caps active milestones per project', () => {
    const { directory, actor } = fixture();
    expectCode(() => createMilestone({ directory, actor, projectId: 'missing', name: 'v1', due: '2026-10-10' }), 'invalid_input');
    const project = createProject({ directory, actor, name: 'Product' });
    expectCode(() => createMilestone({ directory, actor, projectId: project.id, name: 'Bad date', due: '2026-02-30' }), 'invalid_input');
    const first = createMilestone({ directory, actor, projectId: project.id, name: 'V1', due: '2026-12-31', state: 'started', now: 20 });
    expect(first).toMatchObject({ projectId: project.id, due: '2026-12-31', state: 'started', archivedAt: null });
    expect(listMilestones({ directory, actor, projectId: project.id })).toEqual([first]);
    expect(updateMilestone({ directory, actor, milestoneId: first.id, patch: { due: null, state: 'completed' } })).toMatchObject({ due: null, state: 'completed' });
    archiveMilestone({ directory, actor, milestoneId: first.id });
    expect(listMilestones({ directory, actor, projectId: project.id })).toEqual([]);
    expect(restoreMilestone({ directory, actor, milestoneId: first.id }).archivedAt).toBeNull();
    for (let index = 1; index < 50; index++) createMilestone({ directory, actor, projectId: project.id, name: `Milestone ${index}`, due: '2027-01-01' });
    expectCode(() => createMilestone({ directory, actor, projectId: project.id, name: 'Milestone 50', due: '2027-01-01' }), 'limit_exceeded');
    const archivedProject = createProject({ directory, actor, name: 'Archived' });
    archiveProject({ directory, actor, projectId: archivedProject.id });
    expectCode(() => createMilestone({ directory, actor, projectId: archivedProject.id, name: 'Nope', due: '2027-01-01' }), 'invalid_input');
  });

  it('sets tickets by project and project-scoped milestone name, infers a project, and prevents archived assignments', () => {
    const { directory, actor } = fixture();
    const firstProject = createProject({ directory, actor, name: 'Roadmap' });
    const secondProject = createProject({ directory, actor, name: 'Operations' });
    const firstMilestone = createMilestone({ directory, actor, projectId: firstProject.id, name: 'V1', due: '2026-12-01' });
    const secondMilestone = createMilestone({ directory, actor, projectId: secondProject.id, name: 'V1', due: '2027-01-01' });
    const uniqueMilestone = createMilestone({ directory, actor, projectId: firstProject.id, name: 'Only', due: '2026-12-15' });
    const ticket = createTicket({ directory, actor, title: 'Tracked', project: 'rOaDmAp', milestone: 'v1' });
    expect(ticket.project).toEqual({ id: firstProject.id, name: 'Roadmap' });
    expect(ticket.milestone).toEqual({ id: firstMilestone.id, name: 'V1', due: '2026-12-01' });
    expectCode(() => createTicket({ directory, actor, title: 'Ambiguous milestone', milestone: 'V1' }), 'invalid_input');
    const inferred = createTicket({ directory, actor, title: 'Inferred project', milestone: 'Only' });
    expect(inferred.project?.id).toBe(firstProject.id);
    expectCode(() => createTicket({ directory, actor, title: 'Id is not a project name', project: firstProject.id }), 'invalid_input');
    expectCode(() => updateTicket({ directory, actor, key: ticket.key, patch: { project: 'Operations' } }), 'invalid_input');
    const moved = updateTicket({ directory, actor, key: ticket.key, patch: { project: 'Operations', milestone: 'V1' } });
    expect(moved.project?.id).toBe(secondProject.id);
    expect(moved.milestone?.id).toBe(secondMilestone.id);
    expect(updateTicket({ directory, actor, key: ticket.key, patch: { project: null, milestone: null } })).toMatchObject({ project: null, milestone: null });
    archiveMilestone({ directory, actor, milestoneId: firstMilestone.id });
    expectCode(() => updateTicket({ directory, actor, key: ticket.key, patch: { project: 'Roadmap', milestone: 'V1' } }), 'invalid_input');
    archiveProject({ directory, actor, projectId: firstProject.id });
    expectCode(() => updateTicket({ directory, actor, key: ticket.key, patch: { project: 'Roadmap' } }), 'invalid_input');
    expect(getTicket({ directory, actor, key: inferred.key }).milestone?.id).toBe(uniqueMilestone.id);
  });
});
