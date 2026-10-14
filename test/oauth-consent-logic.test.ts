import { describe, expect, it } from 'vitest';
import {
  boardsCeiling,
  decisionBody,
  errorSentence,
  hostPresentation,
  isOAuthEnvelope,
  MAX_OAUTH_BOARD_IDS,
  OAUTH_REQUEST_INVALID,
  roleScope,
  scopeOptions,
  titleText,
  TRACKER_DEFAULT,
  TRACKER_TEXT,
  trackerForDecision,
  trackerOptions,
  trackerWarning,
  verifiedBadge,
  type OAuthDecisionInput,
} from '../src/ui/oauth-consent-logic';

describe('OAuth consent view model', () => {
  it('accepts only opaque base64url-shaped envelopes up to 8192 characters', () => {
    expect(isOAuthEnvelope('aZ09_-')).toBe(true);
    expect(isOAuthEnvelope('a'.repeat(8192))).toBe(true);
    for (const value of ['', 'has space', 'a.b', 'a/b', 'a+b', 'a%20b', 'a'.repeat(8193), null]) {
      expect(isOAuthEnvelope(value)).toBe(false);
    }
  });

  it('offers only access levels up to the server ceiling', () => {
    expect(scopeOptions('read').map(({ value, label, help }) => [value, label, help])).toEqual([
      ['read', 'Read', 'See boards, objects and comments.'],
    ]);
    expect(scopeOptions('comment').map(({ value, label }) => [value, label])).toEqual([
      ['read', 'Read'], ['comment', 'Read and comment'],
    ]);
    expect(scopeOptions('write').map(({ value, label }) => [value, label])).toEqual([
      ['read', 'Read'], ['comment', 'Read and comment'], ['write', 'Read and edit'],
    ]);
  });

  it('caps chosen-board access by the strongest selected role and the server ceiling', () => {
    expect(MAX_OAUTH_BOARD_IDS).toBe(50);
    expect(roleScope('editor')).toBe('write');
    expect(roleScope('owner')).toBe('write');
    expect(roleScope('commenter')).toBe('comment');
    expect(roleScope('viewer')).toBe('read');
    expect(roleScope('admin')).toBe('read');
    expect(boardsCeiling('write', ['viewer', 'commenter'])).toBe('comment');
    expect(boardsCeiling('comment', ['editor'])).toBe('comment');
    expect(boardsCeiling('write', [])).toBe('read');

    // Owners and admins see read for every board together, but can get write on explicitly chosen owner boards.
    const ownerScopes = { unrestricted: 'read' as const, boards: 'write' as const };
    expect(ownerScopes.unrestricted).toBe('read');
    expect(boardsCeiling(ownerScopes.boards, ['owner'])).toBe('write');
  });

  it('labels normal and loopback destinations and exposes verified state', () => {
    expect(hostPresentation('claude.ai', 'https://claude.ai/callback', true)).toEqual({
      label: 'claude.ai', verified: true, warning: null,
    });
    expect(hostPresentation('127.0.0.1:45678', 'http://127.0.0.1:45678/callback', false)).toEqual({
      label: 'an app on this computer (127.0.0.1:45678)', verified: false,
      warning: 'Tabula has not verified this destination. Only continue if you started this connection yourself.',
    });
    expect(hostPresentation('[::1]:6000', 'http://[::1]:6000/callback', false).label)
      .toBe('an app on this computer (127.0.0.1:6000)');
    expect(hostPresentation('localhost', 'http://localhost:45678/callback', false).label)
      .toBe('an app on this computer (localhost:45678)');
  });

  it('labels verified providers and hosts without changing unverified destinations', () => {
    expect(verifiedBadge('Claude', true)).toBe('Verified: Claude');
    expect(verifiedBadge(null, true)).toBe('Verified host');
    expect(verifiedBadge(null, false)).toBeNull();
  });

  it('builds a safe title from plain text fields', () => {
    expect(titleText('Claude', true, 'boards.example')).toBe('An app that claims to be ‘Claude’ wants access to boards.example');
    expect(titleText('Claude', false, 'boards.example')).toBe('An app named ‘Claude’ wants access to boards.example');
    expect(titleText('<img src=x>', true, 'boards.example')).toContain('<img src=x>');
  });

  it('maps server status and code pairs to fixed user-facing sentences', () => {
    expect(errorSentence(404, 'not_found')).toBe(OAUTH_REQUEST_INVALID);
    expect(errorSentence(429, 'rate_limited', 1.2)).toBe('Too many requests. Try again in 2 seconds.');
    expect(errorSentence(429, 'rate_limited', 1)).toBe('Too many requests. Try again in 1 second.');
    expect(errorSentence(402, 'read_only')).toBe('This workspace is read-only. Ask the workspace owner to check billing.');
    expect(errorSentence(409, 'grant_limit')).toBe('You can have at most 20 connected apps. Disconnect one first.');
    expect(errorSentence(400, 'invalid_scope')).toBe('The available access level changed. Review the updated request.');
    expect(errorSentence(400, 'invalid_boards')).toBe('A chosen board is no longer available. Review the updated list.');
  });

  it('constructs exact Allow and Deny bodies, including boards only for a non-empty Allow selection', () => {
    expect(decisionBody({ request: 'opaque', decision: 'allow', scope: 'write', nonce: 'n' })).toEqual({
      request: 'opaque', decision: 'allow', scope: 'write', nonce: 'n',
    });
    expect(decisionBody({ request: 'opaque', decision: 'allow', scope: 'comment', nonce: 'n', boardIds: ['b1', 'b2'] })).toEqual({
      request: 'opaque', decision: 'allow', scope: 'comment', nonce: 'n', boardIds: ['b1', 'b2'],
    });
    expect(Object.keys(decisionBody({ request: 'opaque', decision: 'allow', scope: 'read', nonce: 'n', boardIds: [] })).sort())
      .toEqual(['decision', 'nonce', 'request', 'scope']);
    expect(decisionBody({ request: 'opaque', decision: 'deny', scope: 'write', nonce: 'n' })).toEqual({
      request: 'opaque', decision: 'deny', nonce: 'n',
    });
    expect(Object.keys(decisionBody({ request: 'opaque', decision: 'deny', nonce: 'n' })).sort())
      .toEqual(['decision', 'nonce', 'request']);
  });

  it('offers ticket levels up to the ceiling, lowest first, and always starts on No tickets', () => {
    expect(trackerOptions(null)).toEqual([]);
    expect(trackerOptions(undefined)).toEqual([]);
    expect(trackerOptions('admin' as unknown as 'read')).toEqual([]);
    expect(trackerOptions('read').map(({ value, label }) => [value, label])).toEqual([
      ['none', 'No tickets'], ['read', 'Read tickets'],
    ]);
    expect(trackerOptions('write').map(({ value, label }) => [value, label])).toEqual([
      ['none', 'No tickets'], ['read', 'Read tickets'], ['write', 'Read and edit tickets'],
    ]);
    expect(TRACKER_DEFAULT).toBe('none');
    expect(trackerOptions('read')[0].value).toBe(TRACKER_DEFAULT);
    expect(trackerOptions('write')[0].value).toBe(TRACKER_DEFAULT);
  });

  it('gives each ticket level its approved help line, which is also its warning', () => {
    expect(TRACKER_TEXT.heading).toBe('Tickets');
    expect(trackerWarning('none')).toBe('No access to tickets.');
    expect(trackerWarning('read')).toBe('This app can read every ticket you can see, as you. Text in tickets written by others may try to instruct the app.');
    expect(trackerWarning('write')).toBe('This app can create, change and comment on every ticket you can see, as you. Text in tickets written by others may try to instruct the app; review what it does.');
    expect(trackerOptions('write').map((option) => option.help)).toEqual([
      trackerWarning('none'), trackerWarning('read'), trackerWarning('write'),
    ]);
  });

  it('sends a ticket level only when the ceiling offers it, and never No tickets', () => {
    expect(trackerForDecision('none', 'write')).toBeUndefined();
    expect(trackerForDecision('read', 'write')).toBe('read');
    expect(trackerForDecision('write', 'write')).toBe('write');
    expect(trackerForDecision('read', 'read')).toBe('read');
    expect(trackerForDecision('write', 'read')).toBeUndefined();
    expect(trackerForDecision('read', null)).toBeUndefined();
    expect(trackerForDecision('write', undefined)).toBeUndefined();
  });

  it('adds tickets to Allow only as read or write, and never to Deny', () => {
    expect(decisionBody({ request: 'opaque', decision: 'allow', scope: 'read', nonce: 'n', tracker: 'write' })).toEqual({
      request: 'opaque', decision: 'allow', scope: 'read', nonce: 'n', tracker: 'write',
    });
    expect(decisionBody({ request: 'opaque', decision: 'allow', scope: 'comment', nonce: 'n', boardIds: ['b1'], tracker: 'read' })).toEqual({
      request: 'opaque', decision: 'allow', scope: 'comment', nonce: 'n', boardIds: ['b1'], tracker: 'read',
    });
    // Without a ticket level, or with a value the server does not take, the field is absent.
    expect(Object.keys(decisionBody({ request: 'opaque', decision: 'allow', scope: 'read', nonce: 'n' })).sort())
      .toEqual(['decision', 'nonce', 'request', 'scope']);
    expect(Object.keys(decisionBody({ request: 'opaque', decision: 'allow', scope: 'read', nonce: 'n', tracker: 'none' as unknown as 'read' })).sort())
      .toEqual(['decision', 'nonce', 'request', 'scope']);
    const denyWithTickets = { request: 'opaque', decision: 'deny', nonce: 'n', tracker: 'write' } as OAuthDecisionInput;
    expect(decisionBody(denyWithTickets)).toEqual({ request: 'opaque', decision: 'deny', nonce: 'n' });
    expect(Object.keys(decisionBody(denyWithTickets)).sort()).toEqual(['decision', 'nonce', 'request']);
  });
});
