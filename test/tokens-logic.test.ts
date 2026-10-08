import { describe, expect, it } from 'vitest';
import { MCP_SERVER_NAME } from '../server/mcp.mjs';
import { ADMIN_TABS } from '../src/route';
import {
  DEFAULT_DAYS, EXPIRY_DAYS, aiToolsAvailable, MAX_BOARDS, NAME_MAX, SCOPE_OPTIONS, SERVER_NAME, boardsLabel, boardsSummary, clientSnippets, draftProblem,
  emptyDraft, expiryLabel, lastUsedLabel, needsBoardPick, scopeLabel, toRequest, type Draft,
} from '../src/ui/tokens-logic';

const draft = (extra: Partial<Draft> = {}): Draft => ({ ...emptyDraft(), name: 'Claude Code', ...extra });

describe('names and levels', () => {
  it('registers under the name the server reports', () => {
    expect(SERVER_NAME).toBe(MCP_SERVER_NAME);
  });

  it('offers the three levels, lowest first, and starts on the lowest', () => {
    expect(SCOPE_OPTIONS.map((o) => o.value)).toEqual(['read', 'comment', 'write']);
    expect(emptyDraft().scope).toBe('read');
    expect(scopeLabel('write')).toBe('Read and edit');
    expect(SCOPE_OPTIONS.find((o) => o.value === 'write')?.hint).toContain('every board listed');
  });

  it('offers 7, 30, 90 and 365 days and starts on 30', () => {
    expect([...EXPIRY_DAYS]).toEqual([7, 30, 90, 365]);
    expect(DEFAULT_DAYS).toBe(30);
    expect(emptyDraft().days).toBe(30);
  });

  it('has an admin tab for tokens', () => {
    expect(ADMIN_TABS).toContain('tokens');
  });
});

describe('who must name boards', () => {
  it.each([
    ['owner', 'read', false], ['owner', 'comment', true], ['owner', 'write', true],
    ['admin', 'read', false], ['admin', 'comment', true], ['admin', 'write', true],
    ['member', 'write', false], ['member', 'comment', false], ['guest', 'write', false],
  ] as const)('%s with %s: %s', (role, scope, needs) => {
    expect(needsBoardPick(role, scope)).toBe(needs);
  });
});

describe('a draft token', () => {
  it('is fine with a name and nothing else', () => {
    expect(draftProblem('member', draft())).toBeNull();
    expect(draftProblem('member', draft({ scope: 'write' }))).toBeNull();
  });

  it('needs a name that fits', () => {
    expect(draftProblem('member', draft({ name: '   ' }))).toMatch(/name/);
    expect(draftProblem('member', draft({ name: 'n'.repeat(NAME_MAX) }))).toBeNull();
    expect(draftProblem('member', draft({ name: 'n'.repeat(NAME_MAX + 1) }))).toMatch(/at most 80/);
  });

  it('needs boards when it says "only these"', () => {
    expect(draftProblem('member', draft({ allBoards: false, boardIds: [] }))).toMatch(/at least one board/);
    expect(draftProblem('member', draft({ allBoards: false, boardIds: ['a'] }))).toBeNull();
    const many = Array.from({ length: MAX_BOARDS + 1 }, (_, i) => `b${i}`);
    expect(draftProblem('member', draft({ allBoards: false, boardIds: many }))).toMatch(/at most 20/);
  });

  it('makes owners and admins pick boards for the levels that can write', () => {
    expect(draftProblem('admin', draft({ scope: 'write' }))).toMatch(/pick the boards/);
    expect(draftProblem('owner', draft({ scope: 'comment' }))).toMatch(/pick the boards/);
    expect(draftProblem('owner', draft({ scope: 'write', allBoards: false, boardIds: ['a'] }))).toBeNull();
    expect(draftProblem('owner', draft({ scope: 'read' }))).toBeNull();
  });

  it('refuses an expiry that is not on offer', () => {
    expect(draftProblem('member', draft({ days: 5 }))).toMatch(/expires/);
  });

  it('turns into the request the server takes', () => {
    expect(toRequest(draft({ name: '  Claude Code  ', scope: 'comment', days: 90 }))).toEqual({ name: 'Claude Code', scope: 'comment', days: 90 });
    expect(toRequest(draft({ allBoards: false, boardIds: ['a', 'b'] }))).toEqual({ name: 'Claude Code', scope: 'read', days: 30, boardIds: ['a', 'b'] });
  });
});

describe('labels', () => {
  it('names boards, or counts them when it cannot', () => {
    const titles = new Map([['a', 'Roadmap'], ['b', 'Retro'], ['c', 'Plan']]);
    expect(boardsLabel(null, titles)).toBe('All boards you can access');
    expect(boardsLabel([], titles)).toBe('No boards');
    expect(boardsLabel(['a'], titles)).toBe('Roadmap');
    expect(boardsLabel(['a', 'b'], titles)).toBe('Roadmap, Retro');
    expect(boardsLabel(['a', 'b', 'c'], titles)).toBe('Roadmap, Retro and 1 more');
    expect(boardsLabel(['x'], titles)).toBe('a board');
    expect(boardsSummary(null)).toBe('All boards');
    expect(boardsSummary(['a'])).toBe('1 board');
    expect(boardsSummary(['a', 'b'])).toBe('2 boards');
  });

  it('says when a token expires and when it was used', () => {
    const now = 1_800_000_000_000;
    const day = 24 * 60 * 60 * 1000;
    expect(expiryLabel(now - 1, now)).toBe('Expired');
    expect(expiryLabel(now + 3600_000, now)).toBe('Expires today');
    expect(expiryLabel(now + 1.5 * day, now)).toBe('Expires tomorrow');
    expect(expiryLabel(now + 29.5 * day, now)).toBe('Expires in 30 days');
    expect(lastUsedLabel({ lastUsedAt: null }, () => 'never called')).toBe('Never used');
    expect(lastUsedLabel({ lastUsedAt: now }, (t) => `at ${t}`)).toBe(`Used at ${now}`);
  });
});

describe('what to paste into a tool', () => {
  const url = 'https://tabula.example.com/mcp';
  const token = 'tbl_secretsecretsecret';

  it('gives a Claude Code command that has the address and the token once each', () => {
    const { claudeCode } = clientSnippets(url, token);
    expect(claudeCode).toBe(`claude mcp add --transport http ${SERVER_NAME} ${url} --header "Authorization: Bearer ${token}"`);
    expect(claudeCode.split(token)).toHaveLength(2);
  });

  it('gives settings other tools can read', () => {
    const { config } = clientSnippets(url, token);
    expect(JSON.parse(config)).toEqual({ mcpServers: { [SERVER_NAME]: { type: 'http', url, headers: { Authorization: `Bearer ${token}` } } } });
  });
});

describe('aiToolsAvailable', () => {
  it('is true only when the server reports AI tool access for this person', () => {
    expect(aiToolsAvailable({ mcp: true })).toBe(true);
    expect(aiToolsAvailable({ mcp: false })).toBe(false);
    expect(aiToolsAvailable({})).toBe(false);
    expect(aiToolsAvailable(null)).toBe(false);
    expect(aiToolsAvailable(undefined)).toBe(false);
  });
});
