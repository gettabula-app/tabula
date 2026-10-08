import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHarness, type Account, type Body } from './mcp-harness';

// docs/custom-templates.md, "Accounts mode: the server". The relay runs as a child process in accounts mode.

vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });

const h = createHarness({ accounts: true });
const CLOUD_TOKEN = 'c'.repeat(48);

/** A value with the name of the case it belongs to, so a failure in a loop says which one. */
const at = (label: unknown, value: unknown) => ({ label, value });

const sticky = (id: string, extra: Record<string, unknown> = {}) => ({ id, type: 'sticky', x: 0, y: 0, w: 160, h: 160, rotation: 0, z: id, text: id, ...extra });
const content = (objects: unknown[] = [sticky('a')], extra: Record<string, unknown> = {}) => ({
  objects, steps: [], bounds: { x: 0, y: 0, w: 160, h: 160 }, ...extra,
});
const body = (extra: Record<string, unknown> = {}) => ({ name: 'Retro', category: 'Retrospective', description: 'About', content: content(), ...extra });

let owner: Account;
let admin: Account;
let teamA: string;
let teamB: string;
let lead: Account; // admin of team A
let alice: Account; // member of A
let bob: Account; // member of A
let carol: Account; // member of B only
let gus: Account; // guest, member of A
let outsider: Account; // member of B

const create = (who: Account, extra: Record<string, unknown> = {}) => h.api(who.cookie, 'POST', '/api/templates', body(extra));
const made = async (who: Account, extra: Record<string, unknown> = {}) => {
  const res = await create(who, extra);
  if (res.status !== 201) throw new Error(`could not create a template (${res.status} ${JSON.stringify(res.body)})`);
  return res.body.id as string;
};
const get = (who: Account, id: string) => h.api(who.cookie, 'GET', `/api/templates/${id}`);
const patch = (who: Account, id: string, change: Record<string, unknown>) => h.api(who.cookie, 'PATCH', `/api/templates/${id}`, change);
const del = (who: Account, id: string) => h.api(who.cookie, 'DELETE', `/api/templates/${id}`);
const listed = async (who: Account) => ((await h.api(who.cookie, 'GET', '/api/templates')).body as Body[]).map((t) => t.id as string);
const audit = async (action: string) => ((await h.api(owner.cookie, 'GET', `/api/admin/audit?limit=200&action=${action}`)).body.entries as Body[]).reverse();

const role = async (who: Account, to: string) => {
  const res = await h.api(owner.cookie, 'PATCH', `/api/members/${who.user.id}`, { role: to });
  if (res.status !== 200) throw new Error(`could not change a role (${res.status})`);
};

beforeAll(async () => {
  await h.start();
  owner = await h.signInOwner();
  teamA = (await h.newTeam(owner.cookie, 'Team A')).id;
  teamB = (await h.newTeam(owner.cookie, 'Team B')).id;
  admin = await h.joinTeam(owner.cookie, teamA);
  await role(admin, 'admin');
  lead = await h.joinTeam(owner.cookie, teamA, 'admin');
  alice = await h.joinTeam(owner.cookie, teamA);
  bob = await h.joinTeam(owner.cookie, teamA);
  gus = await h.joinTeam(owner.cookie, teamA);
  await role(gus, 'guest');
  carol = await h.joinTeam(owner.cookie, teamB);
  outsider = await h.joinTeam(owner.cookie, teamB);
});

afterAll(() => h.cleanup());

describe('creating', () => {
  it('stores a personal template and answers with it, content included', async () => {
    const res = await create(alice);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      version: 1, name: 'Retro', category: 'Retrospective', description: 'About', scope: 'personal', teamId: null, teamName: null,
      createdBy: alice.user.id, ownerName: alice.user.name, objectCount: 1, stepCount: 0, canChange: true, content: content(),
    });
    expect(res.body.id).toEqual(expect.any(String));
    expect(res.body.createdAt).toBe(res.body.updatedAt);
    expect((await get(alice, res.body.id)).body).toEqual(res.body);
  });

  it('lists metadata without the content', async () => {
    const id = await made(alice, { name: 'Listed' });
    const list = (await h.api(alice.cookie, 'GET', '/api/templates')).body as Body[];
    const row = list.find((t) => t.id === id)!;
    expect(row).toMatchObject({ name: 'Listed', scope: 'personal', objectCount: 1, canChange: true });
    expect(row).not.toHaveProperty('content');
    const times = list.map((t) => t.updatedAt);
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });

  it('needs a session and the CSRF header', async () => {
    expect((await h.api(undefined, 'GET', '/api/templates')).status).toBe(401);
    expect((await h.api(undefined, 'POST', '/api/templates', body())).status).toBe(401);
    expect((await h.api(alice.cookie, 'POST', '/api/templates', body(), { 'x-tabula': '', 'x-mira': '' })).status).toBe(403);
    expect((await h.api(alice.cookie, 'DELETE', '/api/templates/x', undefined, { 'x-tabula': '', 'x-mira': '' })).status).toBe(403);
  });

  it('refuses guests, even for their own team', async () => {
    const res = await create(gus);
    expect(res.status).toBe(403);
    expect((await create(gus, { scope: 'team', teamId: teamA })).status).toBe(403);
    expect((await h.api(gus.cookie, 'GET', '/api/templates')).status).toBe(200);
  });

  it('lets members share with teams they belong to, and workspace owners and admins with any team', async () => {
    const own = await create(alice, { scope: 'team', teamId: teamA });
    expect(own.status).toBe(201);
    expect(own.body).toMatchObject({ scope: 'team', teamId: teamA, teamName: 'Team A' });
    const other = await create(alice, { scope: 'team', teamId: teamB });
    expect(other.status).toBe(403);
    expect(other.body.message).toBe('You are not a member of that team');
    expect((await create(alice, { scope: 'team', teamId: 'nope' })).status).toBe(403);
    expect((await create(admin, { scope: 'team', teamId: teamB })).status).toBe(201);
    expect((await create(admin, { scope: 'team', teamId: 'nope' })).status).toBe(404);
    expect((await create(alice, { scope: 'team' })).status).toBe(400);
  });

  it('lets only workspace owners and admins share with the whole workspace', async () => {
    expect((await create(alice, { scope: 'workspace' })).status).toBe(403);
    expect((await create(lead, { scope: 'workspace' })).status).toBe(403);
    expect((await create(admin, { scope: 'workspace' })).status).toBe(201);
    expect((await create(owner, { scope: 'workspace' })).status).toBe(201);
  });
});

describe('who sees and changes what', () => {
  it('keeps a personal template to its owner, workspace admins included', async () => {
    const id = await made(alice);
    for (const other of [bob, lead, carol, gus, admin, owner]) {
      expect(at(other.email, (await get(other, id)).status)).toEqual(at(other.email, 404));
      expect((await patch(other, id, { name: 'Mine now' })).status).toBe(404);
      expect((await del(other, id)).status).toBe(404);
      expect((await h.api(other.cookie, 'POST', `/api/templates/${id}/duplicate`)).status).toBe(404);
      expect(await listed(other)).not.toContain(id);
    }
    expect(await listed(alice)).toContain(id);
  });

  it('shows a team template to the team and to workspace admins, and nobody else', async () => {
    const id = await made(alice, { scope: 'team', teamId: teamA });
    for (const member of [alice, bob, lead, gus, admin, owner]) {
      expect(at(member.email, (await get(member, id)).status)).toEqual(at(member.email, 200));
      expect(await listed(member)).toContain(id);
    }
    for (const other of [carol, outsider]) {
      expect((await get(other, id)).status).toBe(404);
      expect((await patch(other, id, { name: 'x' })).status).toBe(404);
      expect((await del(other, id)).status).toBe(404);
      expect(await listed(other)).not.toContain(id);
    }
    expect((await get(bob, id)).body).toMatchObject({ canChange: false, teamName: 'Team A' });
    expect((await get(lead, id)).body.canChange).toBe(true);
  });

  it('lets the owner, a team admin and workspace owners and admins change a team template, and refuses other members and guests', async () => {
    const id = await made(alice, { scope: 'team', teamId: teamA });
    for (const nope of [bob, gus]) {
      expect((await patch(nope, id, { name: 'x' })).status).toBe(403);
      expect((await del(nope, id)).status).toBe(403);
    }
    for (const [who, name] of [[alice, 'By the owner'], [lead, 'By the team admin'], [admin, 'By an admin'], [owner, 'By an owner']] as const) {
      const res = await patch(who, id, { name });
      expect(at(name, res.status)).toEqual(at(name, 200));
      expect(res.body.name).toBe(name);
    }
    const gone = await made(alice, { scope: 'team', teamId: teamA });
    expect((await del(lead, gone)).status).toBe(204);
  });

  it('shows a workspace template to everyone but guests and lets only workspace owners and admins change it', async () => {
    const id = await made(admin, { scope: 'workspace' });
    for (const member of [alice, lead, carol, outsider, admin, owner]) expect(at(member.email, (await get(member, id)).status)).toEqual(at(member.email, 200));
    expect((await get(gus, id)).status).toBe(404);
    expect(await listed(gus)).not.toContain(id);
    for (const nope of [alice, lead, carol]) {
      expect((await patch(nope, id, { name: 'x' })).status).toBe(403);
      expect((await del(nope, id)).status).toBe(403);
    }
    expect((await patch(owner, id, { description: 'Edited' })).status).toBe(200);
    expect((await del(admin, id)).status).toBe(204);
  });

  it('keeps a team template with the team when its owner leaves it, and stops showing it to them', async () => {
    const leaver = await h.joinTeam(owner.cookie, teamA);
    const id = await made(leaver, { scope: 'team', teamId: teamA });
    expect((await h.api(lead.cookie, 'DELETE', `/api/teams/${teamA}/members/${leaver.user.id}`)).status).toBe(204);
    expect((await get(leaver, id)).status).toBe(404);
    expect((await patch(leaver, id, { name: 'x' })).status).toBe(404);
    expect((await get(bob, id)).body).toMatchObject({ createdBy: leaver.user.id, canChange: false });
    expect((await patch(lead, id, { name: 'Kept' })).status).toBe(200);
  });

  it('keeps team and workspace templates when their owner is removed, and shows personal ones of theirs to admins only', async () => {
    const gone = await h.joinTeam(owner.cookie, teamA);
    const inTeam = await made(gone, { scope: 'team', teamId: teamA });
    const personal = await made(gone);
    expect((await h.api(owner.cookie, 'DELETE', `/api/members/${gone.user.id}`)).status).toBe(204);
    expect((await get(bob, inTeam)).body).toMatchObject({ createdBy: '', ownerName: null, canChange: false });
    expect((await patch(lead, inTeam, { name: 'Still here' })).status).toBe(200);
    expect((await get(bob, personal)).status).toBe(404);
    expect((await get(lead, personal)).status).toBe(404);
    expect((await get(admin, personal)).body).toMatchObject({ scope: 'personal', createdBy: '', canChange: true });
    expect((await del(admin, personal)).status).toBe(204);
  });

  it('moves a template between scopes under the same rules as creating one', async () => {
    const id = await made(alice);
    expect((await patch(alice, id, { scope: 'workspace' })).status).toBe(403);
    expect((await patch(alice, id, { scope: 'team', teamId: teamB })).status).toBe(403);
    const shared = await patch(alice, id, { scope: 'team', teamId: teamA });
    expect(shared.status).toBe(200);
    expect(shared.body).toMatchObject({ scope: 'team', teamId: teamA, teamName: 'Team A' });
    expect((await get(bob, id)).status).toBe(200);
    // a team admin may rename it but cannot make someone else's template personal, or publish it to everyone
    expect((await patch(lead, id, { scope: 'personal' })).status).toBe(403);
    expect((await patch(lead, id, { scope: 'workspace' })).status).toBe(403);
    expect((await patch(admin, id, { scope: 'workspace' })).body).toMatchObject({ scope: 'workspace', teamId: null, teamName: null });
    expect((await get(carol, id)).status).toBe(200);
    expect((await patch(alice, id, { scope: 'personal' })).status).toBe(403);
    expect((await patch(admin, id, { scope: 'team', teamId: teamA })).status).toBe(200);
    expect((await patch(alice, id, { scope: 'personal' })).body).toMatchObject({ scope: 'personal', teamId: null });
    expect((await get(bob, id)).status).toBe(404);
    // a team id alone moves a team template to another team
    const team = await made(alice, { scope: 'team', teamId: teamA });
    expect((await patch(alice, team, { teamId: teamB })).status).toBe(403);
    expect((await patch(admin, team, { teamId: teamB })).body).toMatchObject({ scope: 'team', teamId: teamB });
    expect((await patch(alice, id, { teamId: teamA })).status).toBe(400);
  });

  it('changes any of the fields, keeps the rest, and moves the update time', async () => {
    const id = await made(alice);
    const before = (await get(alice, id)).body;
    await new Promise((r) => setTimeout(r, 5));
    const res = await patch(alice, id, { name: ' New name ', category: 'Risk', description: '' });
    expect(res.body).toMatchObject({ name: 'New name', category: 'Risk', description: '', scope: 'personal', content: before.content, createdAt: before.createdAt });
    expect(res.body.updatedAt).toBeGreaterThan(before.updatedAt);
    const next = content([sticky('a'), sticky('b')], { steps: [{ id: 's1', title: 'Go', instructions: '', mode: 'write' }] });
    expect((await patch(alice, id, { content: next })).body).toMatchObject({ objectCount: 2, stepCount: 1, content: next });
    expect((await patch(alice, id, {})).status).toBe(400);
    expect((await patch(alice, id, { owner: 'bob' })).status).toBe(400);
    expect((await patch(alice, id, { category: 'Anything' })).status).toBe(400);
  });
});

describe('duplicating', () => {
  it('makes a personal copy for whoever can read the template, and nobody else sees it', async () => {
    const id = await made(alice, { scope: 'team', teamId: teamA, name: 'Shared retro' });
    const res = await h.api(bob.cookie, 'POST', `/api/templates/${id}/duplicate`);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      name: 'Shared retro (copy)', category: 'Retrospective', description: 'About', scope: 'personal', teamId: null, createdBy: bob.user.id, canChange: true, content: content(),
    });
    expect(res.body.id).not.toBe(id);
    expect((await get(alice, res.body.id)).status).toBe(404);
    expect((await patch(bob, res.body.id, { name: 'Mine' })).status).toBe(200);
    expect((await get(alice, id)).body.name).toBe('Shared retro');
    expect((await h.api(carol.cookie, 'POST', `/api/templates/${id}/duplicate`)).status).toBe(404);
    expect((await h.api(undefined, 'POST', `/api/templates/${id}/duplicate`)).status).toBe(401);
    const rows = await audit('template.create');
    expect(rows.at(-1)).toMatchObject({ actorId: bob.user.id, detail: { templateId: res.body.id, name: 'Shared retro (copy)', scope: 'personal', copiedFrom: id } });
  });

  it('is refused for guests, who cannot create templates', async () => {
    const id = await made(alice, { scope: 'team', teamId: teamA });
    expect((await h.api(gus.cookie, 'POST', `/api/templates/${id}/duplicate`)).status).toBe(403);
  });

  it('keeps the name within its limit', async () => {
    const id = await made(alice, { name: 'x'.repeat(80) });
    const copy = (await h.api(alice.cookie, 'POST', `/api/templates/${id}/duplicate`)).body;
    expect(copy.name).toHaveLength(80);
    expect(copy.name.endsWith(' (copy)')).toBe(true);
  });
});

describe('deleting', () => {
  it('hides the template everywhere and keeps the row', async () => {
    const id = await made(alice, { scope: 'team', teamId: teamA, name: 'Soon gone' });
    expect((await del(alice, id)).status).toBe(204);
    for (const who of [alice, bob, lead, admin, owner]) {
      expect((await get(who, id)).status).toBe(404);
      expect((await patch(who, id, { name: 'x' })).status).toBe(404);
      expect((await del(who, id)).status).toBe(404);
      expect((await h.api(who.cookie, 'POST', `/api/templates/${id}/duplicate`)).status).toBe(404);
      expect(await listed(who)).not.toContain(id);
    }
    const raw = new DatabaseSync(path.join(h.dir, 'directory.sqlite'), { readOnly: true });
    const row = raw.prepare('SELECT name, deleted_at, length(content) AS size FROM templates WHERE id = ?').get(id) as Body;
    raw.close();
    expect(row.name).toBe('Soon gone');
    expect(row.deleted_at).toEqual(expect.any(Number));
    expect(row.size).toBeGreaterThan(0);
  });

  it('is not undone by a later request, and a deleted template does not count against the limit', async () => {
    const id = await made(bob);
    expect((await del(bob, id)).status).toBe(204);
    expect((await patch(bob, id, { name: 'Back' })).status).toBe(404);
  });
});

describe('what is stored', () => {
  it('is only what the server accepts: nothing else from the request survives', async () => {
    const id = await made(alice, {
      content: content([
        sticky('a', { privateStep: 's', locked: true, createdBy: 'x', updatedAt: 1, onclick: 'x()', extra: { deep: true } }),
      ], { extraKey: 1, steps: [] }),
    });
    const stored = (await get(alice, id)).body.content;
    expect(stored).toEqual(content([sticky('a')]));
  });

  it('refuses content that points nowhere, has unknown types, odd numbers or unsafe values', async () => {
    const before = (await listed(alice)).length;
    const refuse = async (c: unknown, message: RegExp) => {
      const res = await create(alice, { content: c });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('bad_request');
      expect(res.body.message).toMatch(message);
    };
    await refuse(content([sticky('a', { parent: 'missing' })]), /parent/);
    await refuse(content([sticky('a'), { id: 'c', type: 'connector', z: '9', from: { kind: 'bound', id: 'missing' }, to: { kind: 'free', x: 0, y: 0 } }]), /not in the template/);
    await refuse(content([sticky('a')], { steps: [{ id: 's', title: 't', instructions: '', mode: 'write', frameId: 'missing' }] }), /frame/);
    await refuse(content([sticky('a', { type: 'iframe' })]), /unknown type/);
    await refuse(content([sticky('a'), sticky('a')]), /shares its id/);
    await refuse(content([sticky('a', { x: 'far' })]), /x must be a number/);
    await refuse(content([sticky('a', { fill: 'url(https://evil.example/a.svg#x)' })]), /fill/);
    await refuse({ objects: 'no', steps: [], bounds: {} }, /content\.objects/);
    await refuse(content(Array.from({ length: 2001 }, (_, i) => sticky(`o${i}`))), /2000 objects/);
    expect((await listed(alice)).length).toBe(before);
  });

  it('refuses unsafe SVG in icons and stickers with a clear message', async () => {
    const icon = (svg: string, extra: Record<string, unknown> = {}) =>
      content([{ id: 'i', type: 'icon', x: 0, y: 0, w: 64, h: 64, rotation: 0, z: '1', ref: 'x:y', body: svg, viewBox: [0, 0, 24, 24], ...extra }]);
    const hostile = [
      '<script>alert(1)</script>',
      '<foreignObject><body onload="x()"/></foreignObject>',
      '<path onload="alert(1)" d="M0 0"/>',
      '<use href="javascript:alert(1)"/>',
      '<image href="data:text/html;base64,PHNjcmlwdD4=" width="1" height="1"/>',
      '<use href="https://evil.example/x.svg#a"/>',
      '<iframe src="https://evil.example"></iframe>',
      '<embed src="x"/>',
      '<object data="x"></object>',
      '<path d="M0 0" onclick = "x()"/>',
    ];
    for (const svg of hostile) {
      for (const extra of [{}, { sticker: true }]) {
        const res = await create(alice, { content: icon(svg, extra) });
        expect(at(svg, res.status)).toEqual(at(svg, 400));
        expect(at(svg, res.body.message)).toEqual(at(svg, expect.stringMatching(/^Object 1 has an SVG body that is not allowed: it /)));
      }
    }
    const fine = await create(alice, { content: icon('<path fill="#FFCC4D" d="M1 2h3z"/>', { sticker: true }) });
    expect(fine.status).toBe(201);
  });

  it('refuses a category that is not on the fixed list, and fields it does not know', async () => {
    for (const category of ['Whatever', 'retrospective', '', 5, null]) expect(at(category, (await create(alice, { category })).status)).toEqual(at(category, 400));
    expect((await create(alice, { category: 'Custom' })).status).toBe(201);
    expect((await create(alice, { name: '' })).status).toBe(400);
    expect((await create(alice, { name: 'x'.repeat(81) })).status).toBe(400);
    expect((await create(alice, { description: 'x'.repeat(281) })).status).toBe(400);
    expect((await create(alice, { scope: 'galaxy' })).status).toBe(400);
    const unknown = await create(alice, { createdBy: 'someone else' });
    expect(unknown.status).toBe(400);
    expect(unknown.body.message).toBe('Unknown field: createdBy');
  });
});

describe('size', () => {
  const bulky = (kilobytes: number) => content(Array.from({ length: Math.ceil(kilobytes / 15) }, (_, i) => sticky(`o${i}`, { text: 'x'.repeat(15_000) })));

  it('accepts a template of 900 KB', async () => {
    const big = bulky(900);
    expect(JSON.stringify(big).length).toBeGreaterThan(900_000);
    const res = await create(alice, { content: big });
    expect(res.status).toBe(201);
    expect(res.body.objectCount).toBe(60);
    expect((await get(alice, res.body.id)).body.content).toEqual(big);
    expect((await h.api(alice.cookie, 'POST', `/api/templates/${res.body.id}/duplicate`)).status).toBe(201);
    expect((await patch(alice, res.body.id, { name: 'Big and renamed' })).status).toBe(200);
  });

  it('refuses a request over 1 MB with 413, and keeps working afterwards', async () => {
    const res = await create(alice, { content: bulky(1200) });
    expect(res.status).toBe(413);
    expect(res.body.error).toBe('payload_too_large');
    expect((await h.api(alice.cookie, 'PATCH', `/api/templates/${await made(alice)}`, { content: bulky(1200) })).status).toBe(413);
    expect((await h.api(alice.cookie, 'GET', '/api/me')).status).toBe(200);
  });

  it('refuses content over 1 MB that still fits the request with 400', async () => {
    const res = await create(alice, { content: bulky(1010) });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/1 MB/);
  });

  it('keeps the other routes at 64 KB', async () => {
    expect((await h.api(alice.cookie, 'POST', '/api/teams', { name: 'x'.repeat(70 * 1024) })).status).toBe(413);
    expect((await h.api(alice.cookie, 'PATCH', '/api/me', { name: 'x'.repeat(70 * 1024) })).status).toBe(413);
  });
});

describe('audit', () => {
  it('writes a row for every create, update and delete, with the name and scope and never the content', async () => {
    const id = await made(alice, { name: 'Audited', content: content([sticky('a', { text: 'SECRETWORDS' })]) });
    await patch(alice, id, { name: 'Audited too', scope: 'team', teamId: teamA });
    await del(lead, id);
    const rows = (await audit('template.')).filter((e) => e.detail.templateId === id);
    expect(rows.map((e) => e.action)).toEqual(['template.create', 'template.update', 'template.delete']);
    expect(rows[0]).toMatchObject({ actorId: alice.user.id, detail: { templateId: id, name: 'Audited', scope: 'personal' } });
    expect(rows[1]).toMatchObject({ actorId: alice.user.id, detail: { name: 'Audited too', scope: 'team', teamId: teamA } });
    expect(rows[2]).toMatchObject({ actorId: lead.user.id, detail: { name: 'Audited too', scope: 'team' } });
    expect(JSON.stringify((await h.api(owner.cookie, 'GET', '/api/admin/audit?limit=200')).body)).not.toContain('SECRETWORDS');
  });

  it('writes nothing for a refused request', async () => {
    const before = (await audit('template.')).length;
    await create(alice, { scope: 'workspace' });
    await create(alice, { category: 'Nope' });
    await patch(bob, await made(alice, { scope: 'team', teamId: teamA }), { name: 'x' });
    expect((await audit('template.')).length).toBe(before + 1);
  });
});

describe('limits', () => {
  it('stops one person from keeping more than 200 templates', async () => {
    const hoarder = await h.joinTeam(owner.cookie, teamA);
    const tiny = content([sticky('a')]);
    for (let i = 0; i < 200; i += 4) {
      const batch = await Promise.all([0, 1, 2, 3].map(() => h.api(hoarder.cookie, 'POST', '/api/templates', { name: 'T', category: 'Custom', content: tiny })));
      expect(batch.map((r) => r.status)).toEqual([201, 201, 201, 201]);
    }
    const over = await create(hoarder);
    expect(over.status).toBe(409);
    expect(over.body.error).toBe('template_limit');
    expect((await h.api(hoarder.cookie, 'POST', `/api/templates/${(await h.api(hoarder.cookie, 'GET', '/api/templates')).body[0].id}/duplicate`)).status).toBe(409);
    const [first] = (await h.api(hoarder.cookie, 'GET', '/api/templates')).body as Body[];
    expect((await del(hoarder, first.id)).status).toBe(204);
    expect((await create(hoarder)).status).toBe(201);
  });
});

describe('a read-only hosted workspace', () => {
  const cloud = createHarness({
    accounts: true,
    settings: { CLOUD_TOKEN, CLOUD_URL: 'http://127.0.0.1:9', CLOUD_WORKSPACE_ID: 'ws_templates_test' },
  });
  const limits = (change: Record<string, unknown>) => cloud.api(undefined, 'PUT', '/api/internal/limits', change, { authorization: `Bearer ${CLOUD_TOKEN}` });
  let wsOwner: Account;
  let member: Account;

  beforeAll(async () => {
    await cloud.start();
    wsOwner = await cloud.signInOwner();
    member = await cloud.joinTeam(wsOwner.cookie, (await cloud.newTeam(wsOwner.cookie)).id);
  });
  afterAll(() => cloud.cleanup());

  it('lets people read templates and refuses every write with 402, and works again when it is lifted', async () => {
    const id = (await cloud.api(member.cookie, 'POST', '/api/templates', body())).body.id as string;
    expect((await limits({ readOnly: true })).status).toBe(200);
    expect((await cloud.api(member.cookie, 'GET', '/api/templates')).status).toBe(200);
    expect((await cloud.api(member.cookie, 'GET', `/api/templates/${id}`)).body.content).toEqual(content());
    for (const [method, url, payload] of [
      ['POST', '/api/templates', body()],
      ['PATCH', `/api/templates/${id}`, { name: 'Changed' }],
      ['POST', `/api/templates/${id}/duplicate`, undefined],
      ['DELETE', `/api/templates/${id}`, undefined],
    ] as const) {
      const res = await cloud.api(member.cookie, method, url, payload);
      expect(res.status, `${method} ${url}`).toBe(402);
      expect(res.body.error).toBe('read_only');
    }
    expect((await cloud.api(member.cookie, 'GET', `/api/templates/${id}`)).body.name).toBe('Retro');
    await limits({ readOnly: false });
    expect((await cloud.api(member.cookie, 'PATCH', `/api/templates/${id}`, { name: 'Changed' })).status).toBe(200);
    expect((await cloud.api(member.cookie, 'DELETE', `/api/templates/${id}`)).status).toBe(204);
  });
});
