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
      .toBe('an app on this computer (127.0.0.1:45678)');
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
    expect(errorSentence(400, 'invalid_boards')).toBe('One of the chosen boards is no longer available. Review the updated list.');
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
});
