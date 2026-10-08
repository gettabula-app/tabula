import { describe, expect, it } from 'vitest';
import { needsSignIn, parseRoute, resolveRoute, returnHash, type AdminTab, type Route } from '../src/route';
import type { AuthState } from '../src/auth';

type Mode = AuthState['mode'];

const home: Route = { name: 'home' };
const templates: Route = { name: 'templates' };
const signin: Route = { name: 'signin' };
const board = (id: string): Route => ({ name: 'board', id });
const verify = (token: string): Route => ({ name: 'verify', token });
const invite = (token: string): Route => ({ name: 'invite', token });
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
    ['#/admin', admin('overview')],
    ['#/admin/', admin('overview')],
    ['#/admin/overview', admin('overview')],
    ['#/admin/members', admin('members')],
    ['#/admin/teams', admin('teams')],
    ['#/admin/boards', admin('boards')],
    ['#/admin/sessions', admin('sessions')],
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
    ['#/b/abc', board('abc')],
    ['#/templates', templates],
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
    ['signed-in', '#/templates', templates],
    ['signed-out', '#/templates', templates],
    ['offline', '#/templates', templates],
  ])('%s: %j', (mode, hash, route) => {
    expect(resolveRoute(hash, mode)).toEqual(route);
  });
});

describe('needsSignIn', () => {
  const routes: [string, Route][] = [
    ['home', home],
    ['templates', templates],
    ['board', board('abc')],
    ['signin', signin],
    ['verify', verify('abc')],
    ['invite', invite('abc')],
    ['admin', admin('members')],
  ];
  const gated: Record<Mode, string[]> = {
    unknown: [],
    open: [],
    offline: [],
    'signed-in': [],
    'signed-out': ['home', 'templates', 'board', 'admin'],
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
