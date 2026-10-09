import { describe, expect, it } from 'vitest';
import { needsSignIn, parseRoute, resolveRoute, returnHash, type AdminTab, type Route } from '../src/route';
import type { AuthState } from '../src/auth';

type Mode = AuthState['mode'];

const home: Route = { name: 'home' };
const templates: Route = { name: 'templates' };
const signin: Route = { name: 'signin' };
const templateEdit = (id: string): Route => ({ name: 'template-edit', id });
const board = (id: string): Route => ({ name: 'board', id });
const verify = (token: string): Route => ({ name: 'verify', token });
const invite = (token: string): Route => ({ name: 'invite', token });
const join = (code = ''): Route => ({ name: 'join', code });
const admin = (tab: AdminTab): Route => ({ name: 'admin', tab });

describe('parseRoute', () => {
  it.each<[string, Route]>([
    ['', home],
    ['#', home],
    ['#/', home],
    ['#/b/abc123', board('abc123')],
    ['#/b/A_b-9', board('A_b-9')],
    ['#/b/' + 'a'.repeat(64), board('a'.repeat(64))],
    ['#/b/' + 'a'.repeat(65), home],
    ['#/b/', home],
    ['#/b/has space', home],
    ['#/b/abc/extra', home],
    ['#/signin', signin],
    ['#/templates', templates],
    ['#/templates/', home],
    ['#/templates/extra', home],
    ['#/templates?x=1', home],
    ['#/template', home],
    ['#/t/abc123/edit', templateEdit('abc123')],
    ['#/t/A_b-9/edit', templateEdit('A_b-9')],
    ['#/t/' + 'a'.repeat(64) + '/edit', templateEdit('a'.repeat(64))],
    ['#/t/' + 'a'.repeat(65) + '/edit', home],
    ['#/t//edit', home],
    ['#/t/abc', home],
    ['#/t/abc/', home],
    ['#/t/abc/edit/', home],
    ['#/t/abc/edit/x', home],
    ['#/t/has space/edit', home],
    ['#/t/abc/view', home],
    ['#/chat', { name: 'chat' }],
    ['#/chat/team/t1', { name: 'chat', kind: 'team', ref: 't1' }],
    ['#/chat/workspace/main', { name: 'chat', kind: 'workspace', ref: 'main' }],
    ['#/chat/board/' + 'a'.repeat(64), { name: 'chat', kind: 'board', ref: 'a'.repeat(64) }],
    ['#/chat/board/' + 'a'.repeat(65), home],
    ['#/chat/room/x', home],
    ['#/chat/team', home],
    ['#/chat/team/', home],
    ['#/chat/', home],
    ['#/chat/team/a/b', home],
    ['#/admin', admin('overview')],
    ['#/admin/', admin('overview')],
    ['#/admin/overview', admin('overview')],
    ['#/admin/members', admin('members')],
    ['#/admin/teams', admin('teams')],
    ['#/admin/boards', admin('boards')],
    ['#/admin/sessions', admin('sessions')],
    ['#/admin/settings', admin('settings')],
    ['#/admin/audit', admin('audit')],
    ['#/admin/bogus', admin('overview')],
    ['#/admin/members/x', home],
    ['#/admin/members/', home],
    ['#/signin/verify?token=abc', verify('abc')],
    ['#/signin/verify?token=a%2Bb', verify('a+b')],
    ['#/signin/verify?x=1&token=abc_-9', verify('abc_-9')],
    ['#/signin/verify?token=', signin],
    ['#/signin/verify?other=1', signin],
    ['#/signin/verify', signin],
    ['#/invite/tok_en-1', invite('tok_en-1')],
    ['#/join', join()],
    ['#/join?c=ABCD2345', join('ABCD2345')],
    ['#/invite/', home],
    ['#/invite/a/b', home],
    ['#/unknown', home],
    ['#/signin/other', home],
    ['b/abc', home],
  ])('%j', (hash, route) => {
    expect(parseRoute(hash)).toEqual(route);
  });
});

describe('resolveRoute', () => {
  it.each<[string, Route]>([
    ['#/signin', home],
    ['#/signin/verify?token=abc', home],
    ['#/invite/abc', home],
    ['#/admin', home],
    ['#/admin/members', home],
    ['#/chat', home],
    ['#/chat/team/t1', home],
    ['#/b/abc', board('abc')],
    ['#/templates', templates],
    ['#/t/abc/edit', templateEdit('abc')],
    ['#/', home],
  ])('open mode: %j', (hash, route) => {
    expect(resolveRoute(hash, 'open')).toEqual(route);
  });

  it.each<[Mode, string, Route]>([
    ['signed-out', '#/signin', signin],
    ['signed-in', '#/signin', signin],
    ['offline', '#/signin', signin],
    ['signed-in', '#/admin/audit', admin('audit')],
    ['offline', '#/admin/members', admin('members')],
    ['signed-in', '#/signin/verify?token=abc', verify('abc')],
    ['signed-out', '#/invite/abc', invite('abc')],
    ['offline', '#/b/abc', board('abc')],
    ['signed-in', '#/chat', { name: 'chat' }],
    ['offline', '#/chat/team/t1', { name: 'chat', kind: 'team', ref: 't1' }],
    ['signed-in', '#/templates', templates],
    ['signed-out', '#/templates', templates],
    ['offline', '#/templates', templates],
    ['signed-in', '#/t/abc/edit', templateEdit('abc')],
    ['signed-out', '#/t/abc/edit', templateEdit('abc')],
    ['offline', '#/t/abc/edit', templateEdit('abc')],
  ])('%s: %j', (mode, hash, route) => {
    expect(resolveRoute(hash, mode)).toEqual(route);
  });

  it('reads a direct /join path and its query code', () => {
    expect(resolveRoute('', 'signed-out', '/join', '?c=ABCD2345')).toEqual(join('ABCD2345'));
  });
});

describe('needsSignIn', () => {
  const routes: [string, Route][] = [
    ['home', home],
    ['templates', templates],
    ['template-edit', templateEdit('abc')],
    ['board', board('abc')],
    ['signin', signin],
    ['verify', verify('abc')],
    ['invite', invite('abc')],
    ['join', join('ABCD2345')],
    ['admin', admin('members')],
    ['chat', { name: 'chat' }],
  ];
  const gated: Record<Mode, string[]> = {
    unknown: [],
    open: [],
    guest: [],
    offline: [],
    'signed-in': [],
    'signed-out': ['home', 'templates', 'template-edit', 'board', 'admin', 'chat'],
  };

  it.each(Object.entries(gated).flatMap(([mode, names]) =>
    routes.map(([name, route]) => [mode as Mode, name, names.includes(name), route] as const)))(
    '%s, %s route: gated %s',
    (mode, _name, expected, route) => {
      expect(needsSignIn(route, mode)).toBe(expected);
    },
  );
});

describe('returnHash', () => {
  it.each<[string, string | null]>([
    ['#/b/abc', '#/b/abc'],
    ['#/', null],
    ['', null],
    ['#/templates', null],
    ['#/t/abc/edit', null],
    ['#/signin', null],
    ['#/signin/verify?token=abc', null],
    ['#/invite/abc', null],
    ['#/admin/members', null],
    ['#/b/' + 'a'.repeat(65), null],
    ['https://elsewhere.example/', null],
  ])('%j', (hash, expected) => {
    expect(returnHash(hash)).toBe(expected);
  });
});
