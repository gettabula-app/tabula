import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  COOLDOWN_MS, FUTURE_SKEW_MS, MAX_MUTED, PROMPT_MS, REQUEST_TTL_MS, RequestTracker, buildRequest, cameraToView, cooldownLabel, cooldownLeft,
  isFollowedBy, isMuted, loadMuted, mutePerson, mutedKey, parseMuted, parseRequest, parseView, promptLifetime, rateKey, requestText,
  sameCamera, saveMuted, serializeMuted, unmutePerson, viewDiffers, viewToCamera, type FocusRequest, type RecipientContext,
} from '../src/focus-requests';

const NOW = 1_000_000;

const sent = (over: Partial<FocusRequest> = {}): FocusRequest => ({
  id: 'r1', x: 100, y: -40, zoom: 1.5, ts: NOW, kind: 'view', from: { id: 'ana', name: 'Ana', color: '#2f6fed' }, ...over,
});

const ctx = (over: Partial<RecipientContext> = {}): RecipientContext => ({ now: NOW, me: 'me', muted: [], following: null, ...over });

describe('buildRequest and requestText', () => {
  it('builds a view request', () => {
    const r = buildRequest({ id: 'a', now: NOW, from: { id: 'ana', name: 'Ana', color: '#fff' }, view: { x: 1, y: 2, zoom: 3 } });
    expect(r).toEqual({ id: 'a', x: 1, y: 2, zoom: 3, ts: NOW, kind: 'view', from: { id: 'ana', name: 'Ana', color: '#fff' } });
    expect(requestText(r)).toBe('Ana asks you to look at their view');
  });

  it('builds a step request with the step id and title', () => {
    const r = buildRequest({ id: 'a', now: NOW, from: { id: 'ana', name: 'Ana', color: '#fff' }, view: { x: 1, y: 2, zoom: 1 }, step: { id: 's1', title: 'Cluster' } });
    expect(r.kind).toBe('step');
    expect(r.stepId).toBe('s1');
    expect(requestText(r)).toBe('Ana moved to step "Cluster"');
  });

  it('survives a round trip through the parser', () => {
    const view = buildRequest({ id: 'a', now: NOW, from: { id: 'ana', name: 'Ana', color: '#ABC' }, view: { x: 1, y: 2, zoom: 3 } });
    const step = buildRequest({ id: 'b', now: NOW, from: { id: 'ana', name: 'Ana', color: '#ABC' }, view: { x: 1, y: 2, zoom: 1 }, step: { id: 's1', title: 'Cluster' } });
    expect(parseRequest(JSON.parse(JSON.stringify(view)))).toEqual(view);
    expect(parseRequest(JSON.parse(JSON.stringify(step)))).toEqual(step);
  });
});

describe('parseRequest', () => {
  it('accepts a well-formed request', () => {
    expect(parseRequest(sent())).toEqual(sent());
  });

  it('rejects anything that is not an object', () => {
    for (const v of [null, undefined, 'x', 7, true, []]) expect(parseRequest(v)).toBeNull();
  });

  it('rejects a missing or empty id, coordinate, zoom or time', () => {
    const base = sent();
    for (const key of ['id', 'x', 'y', 'zoom', 'ts', 'kind', 'from'] as const) {
      const copy: Record<string, unknown> = { ...base };
      delete copy[key];
      expect([key, parseRequest(copy)]).toEqual([key, null]);
    }
    expect(parseRequest({ ...base, id: '' })).toBeNull();
    expect(parseRequest({ ...base, id: 'x'.repeat(101) })).toBeNull();
  });

  it('rejects numbers that are not finite or out of range', () => {
    for (const bad of [Number.NaN, Infinity, -Infinity, '5', null]) {
      expect(parseRequest({ ...sent(), x: bad })).toBeNull();
      expect(parseRequest({ ...sent(), ts: bad })).toBeNull();
    }
    expect(parseRequest({ ...sent(), x: 1e9 })).toBeNull();
    expect(parseRequest({ ...sent(), y: -1e9 })).toBeNull();
    expect(parseRequest({ ...sent(), zoom: 0 })).toBeNull();
    expect(parseRequest({ ...sent(), zoom: -1 })).toBeNull();
    expect(parseRequest({ ...sent(), zoom: 65 })).toBeNull();
  });

  it('rejects an unknown kind', () => {
    expect(parseRequest({ ...sent(), kind: 'summon' })).toBeNull();
    expect(parseRequest({ ...sent(), kind: undefined })).toBeNull();
  });

  it('needs a sender with an id, and gives a nameless one a name', () => {
    expect(parseRequest({ ...sent(), from: { name: 'Ana' } })).toBeNull();
    expect(parseRequest({ ...sent(), from: 'ana' })).toBeNull();
    expect(parseRequest({ ...sent(), from: { id: 'ana', name: '   ', color: '#fff' } })?.from.name).toBe('Someone');
    expect(parseRequest({ ...sent(), from: { id: 'ana', name: 7 } })?.from.name).toBe('Someone');
  });

  it('trims and caps names, and flattens whitespace', () => {
    const r = parseRequest({ ...sent(), from: { id: 'ana', name: `  Ana\n\tMaria ${'x'.repeat(80)}`, color: '#fff' } });
    expect(r?.from.name.startsWith('Ana Maria x')).toBe(true);
    expect(r?.from.name.length).toBe(40);
  });

  it('keeps a hex colour and drops anything else, so it never reaches a style attribute', () => {
    expect(parseRequest(sent())?.from.color).toBe('#2f6fed');
    for (const bad of ['red', 'url(javascript:1)', '#12', '#zzzzzz', 'rgb(1,2,3)', '#fff;background:red', 5, null]) {
      expect([String(bad), parseRequest({ ...sent(), from: { id: 'ana', name: 'Ana', color: bad } })?.from.color]).toEqual([String(bad), '']);
    }
  });

  it('needs a step id and a title for a step request, and caps the title', () => {
    const step = { ...sent(), kind: 'step', stepId: 's1', stepTitle: 'Cluster' };
    expect(parseRequest(step)?.stepTitle).toBe('Cluster');
    expect(parseRequest({ ...step, stepTitle: '  ' })).toBeNull();
    expect(parseRequest({ ...step, stepTitle: undefined })).toBeNull();
    expect(parseRequest({ ...step, stepId: undefined })).toBeNull();
    expect(parseRequest({ ...step, stepTitle: 'y'.repeat(200) })?.stepTitle?.length).toBe(80);
  });

  it('ignores step fields on a view request', () => {
    const r = parseRequest({ ...sent(), stepId: 's1', stepTitle: 'Cluster' });
    expect(r).toEqual(sent());
  });

  it('copies fields instead of passing the raw object through', () => {
    const r = parseRequest({ ...sent(), extra: 'x', from: { id: 'ana', name: 'Ana', color: '#fff', admin: true } }) as unknown as Record<string, unknown>;
    expect(r.extra).toBeUndefined();
    expect((r.from as Record<string, unknown>).admin).toBeUndefined();
  });
});

describe('the sender cooldown', () => {
  it('allows the first request and waits 10 seconds after each', () => {
    expect(cooldownLeft(null, NOW)).toBe(0);
    expect(cooldownLeft(NOW, NOW)).toBe(COOLDOWN_MS);
    expect(cooldownLeft(NOW, NOW + 3_000)).toBe(7_000);
    expect(cooldownLeft(NOW, NOW + COOLDOWN_MS - 1)).toBe(1);
    expect(cooldownLeft(NOW, NOW + COOLDOWN_MS)).toBe(0);
    expect(cooldownLeft(NOW, NOW + 60_000)).toBe(0);
  });

  it('never waits longer than the cooldown when the clock went backwards', () => {
    expect(cooldownLeft(NOW, NOW - 3_600_000)).toBe(COOLDOWN_MS);
  });

  it('counts the tooltip down in whole seconds', () => {
    expect(cooldownLabel(10_000)).toBe('Ask again in 10 s');
    expect(cooldownLabel(9_001)).toBe('Ask again in 10 s');
    expect(cooldownLabel(1_200)).toBe('Ask again in 2 s');
    expect(cooldownLabel(1)).toBe('Ask again in 1 s');
    expect(cooldownLabel(0)).toBe('Ask again in 1 s');
  });
});

describe('RequestTracker', () => {
  it('shows a fresh request from someone else', () => {
    expect(new RequestTracker().evaluate(sent(), ctx())).toEqual({ show: true });
  });

  it('ignores my own request, so my other tab does not prompt me', () => {
    expect(new RequestTracker().evaluate(sent({ from: { id: 'me', name: 'Me', color: '' } }), ctx())).toEqual({ show: false, reason: 'own' });
  });

  it('judges a request id once, however often the awareness state changes', () => {
    const t = new RequestTracker();
    expect(t.evaluate(sent(), ctx()).show).toBe(true);
    expect(t.evaluate(sent(), ctx({ now: NOW + 1 }))).toEqual({ show: false, reason: 'duplicate' });
    expect(t.hasSeen('r1')).toBe(true);
    expect(t.hasSeen('other')).toBe(false);
  });

  it('ignores a request from the future beyond the clock tolerance', () => {
    const t = new RequestTracker();
    expect(t.evaluate(sent({ id: 'a', ts: NOW + FUTURE_SKEW_MS }), ctx()).show).toBe(true);
    expect(t.evaluate(sent({ id: 'b', ts: NOW + FUTURE_SKEW_MS + 1 }), ctx())).toEqual({ show: false, reason: 'future' });
    expect(t.evaluate(sent({ id: 'c', ts: NOW + 3_600_000 }), ctx())).toEqual({ show: false, reason: 'future' });
  });

  it('ignores a request older than 30 seconds', () => {
    const t = new RequestTracker();
    expect(t.evaluate(sent({ id: 'a', ts: NOW - REQUEST_TTL_MS }), ctx()).show).toBe(true);
    expect(t.evaluate(sent({ id: 'b', ts: NOW - REQUEST_TTL_MS - 1 }), ctx())).toEqual({ show: false, reason: 'stale' });
    expect(t.evaluate(sent({ id: 'c', ts: 0 }), ctx())).toEqual({ show: false, reason: 'stale' });
  });

  it('ignores a muted person silently, and only that person', () => {
    const muted = [{ id: 'ana', name: 'Ana' }];
    const t = new RequestTracker();
    expect(t.evaluate(sent(), ctx({ muted }))).toEqual({ show: false, reason: 'muted' });
    expect(t.evaluate(sent({ id: 'r2', from: { id: 'bo', name: 'Bo', color: '' } }), ctx({ muted })).show).toBe(true);
  });

  it('does not prompt for the person this tab follows', () => {
    const t = new RequestTracker();
    expect(t.evaluate(sent(), ctx({ following: 'ana' }))).toEqual({ show: false, reason: 'following' });
    expect(t.evaluate(sent({ id: 'r2', kind: 'step', stepId: 's1', stepTitle: 'A' }), ctx({ following: 'ana' }))).toEqual({ show: false, reason: 'following' });
    expect(t.evaluate(sent({ id: 'r3', from: { id: 'bo', name: 'Bo', color: '' } }), ctx({ following: 'ana' })).show).toBe(true);
  });

  it('ignores a repeat from the same person within 10 seconds, and allows one after', () => {
    const t = new RequestTracker();
    expect(t.evaluate(sent({ id: 'a', ts: NOW }), ctx()).show).toBe(true);
    expect(t.evaluate(sent({ id: 'b', ts: NOW + 9_000 }), ctx({ now: NOW + 9_999 }))).toEqual({ show: false, reason: 'rate' });
    expect(t.evaluate(sent({ id: 'c', ts: NOW + 10_000 }), ctx({ now: NOW + COOLDOWN_MS })).show).toBe(true);
  });

  it('does not let an ignored repeat extend the wait', () => {
    const t = new RequestTracker();
    t.evaluate(sent({ id: 'a' }), ctx());
    expect(t.evaluate(sent({ id: 'b', ts: NOW + 5_000 }), ctx({ now: NOW + 5_000 })).show).toBe(false);
    expect(t.evaluate(sent({ id: 'c', ts: NOW + COOLDOWN_MS }), ctx({ now: NOW + COOLDOWN_MS })).show).toBe(true);
  });

  it('keeps the wait per person', () => {
    const t = new RequestTracker();
    expect(t.evaluate(sent({ id: 'a' }), ctx()).show).toBe(true);
    expect(t.evaluate(sent({ id: 'b', from: { id: 'bo', name: 'Bo', color: '' } }), ctx()).show).toBe(true);
  });

  it('counts a muted or stale request as nothing, so unmuting does not replay it', () => {
    const t = new RequestTracker();
    t.evaluate(sent({ id: 'a' }), ctx({ muted: [{ id: 'ana', name: 'Ana' }] }));
    expect(t.evaluate(sent({ id: 'b' }), ctx()).show).toBe(true);
  });

  it('treats a step request for a new step as new, and a repeat for the same step as a repeat', () => {
    const step = (id: string, stepId: string) => sent({ id, kind: 'step', stepId, stepTitle: stepId });
    const t = new RequestTracker();
    expect(t.evaluate(step('a', 's1'), ctx()).show).toBe(true);
    expect(t.evaluate(step('b', 's2'), ctx({ now: NOW + 2_000 })).show).toBe(true);
    expect(t.evaluate(step('c', 's2'), ctx({ now: NOW + 3_000 }))).toEqual({ show: false, reason: 'rate' });
  });

  it('keeps a view request and a step request apart', () => {
    const t = new RequestTracker();
    expect(t.evaluate(sent({ id: 'a' }), ctx()).show).toBe(true);
    expect(t.evaluate(sent({ id: 'b', kind: 'step', stepId: 's1', stepTitle: 'A' }), ctx()).show).toBe(true);
    expect(rateKey(sent())).not.toBe(rateKey(sent({ kind: 'step', stepId: 's1', stepTitle: 'A' })));
  });

  it('forgets old requests, so memory stays small and a very old id can be reused', () => {
    const t = new RequestTracker();
    t.evaluate(sent({ id: 'a' }), ctx());
    t.evaluate(sent({ id: 'b', ts: NOW + REQUEST_TTL_MS * 3 }), ctx({ now: NOW + REQUEST_TTL_MS * 3 }));
    expect(t.hasSeen('a')).toBe(false);
    expect(t.hasSeen('b')).toBe(true);
  });
});

describe('promptLifetime', () => {
  it('is 20 seconds for a fresh request', () => {
    expect(promptLifetime(sent(), NOW)).toBe(PROMPT_MS);
    expect(promptLifetime(sent({ ts: NOW + FUTURE_SKEW_MS }), NOW)).toBe(PROMPT_MS);
  });

  it('is shorter when the request is old, and never negative', () => {
    expect(promptLifetime(sent(), NOW + 15_000)).toBe(15_000);
    expect(promptLifetime(sent(), NOW + REQUEST_TTL_MS)).toBe(0);
    expect(promptLifetime(sent(), NOW + REQUEST_TTL_MS + 5_000)).toBe(0);
  });
});

describe('muted people', () => {
  const ana = { id: 'ana', name: 'Ana' };
  const bo = { id: 'bo', name: 'Bo' };

  it('keys by person and board under the driftboard prefix', () => {
    expect(mutedKey('me', 'board-1')).toBe('driftboard:focus-muted:me:board-1');
  });

  it('serializes a list and an empty list as nothing to store', () => {
    expect(serializeMuted([])).toBeNull();
    expect(JSON.parse(serializeMuted([ana, bo])!)).toEqual([ana, bo]);
  });

  it('reads back what it wrote', () => {
    expect(parseMuted(serializeMuted([ana, bo]))).toEqual([ana, bo]);
  });

  it('reads nothing as nobody, and so does anything unreadable', () => {
    expect(parseMuted(null)).toEqual([]);
    expect(parseMuted('')).toEqual([]);
    expect(parseMuted('not json')).toEqual([]);
    expect(parseMuted('{"id":"ana"}')).toEqual([]);
    expect(parseMuted('"ana"')).toEqual([]);
  });

  it('skips bad entries, repeats and entries without an id; and names the nameless', () => {
    const raw = JSON.stringify([ana, null, 'x', { name: 'No id' }, { id: '' }, { id: 'ana', name: 'Again' }, { id: 'cy' }, { id: 'di', name: 5 }]);
    expect(parseMuted(raw)).toEqual([ana, { id: 'cy', name: 'Someone' }, { id: 'di', name: 'Someone' }]);
  });

  it('keeps at most the newest 200', () => {
    const many = Array.from({ length: MAX_MUTED + 20 }, (_, i) => ({ id: `u${i}`, name: `U${i}` }));
    const parsed = parseMuted(JSON.stringify(many));
    expect(parsed).toHaveLength(MAX_MUTED);
    expect(parsed[parsed.length - 1].id).toBe(`u${MAX_MUTED + 19}`);
    const muted = mutePerson(many.slice(0, MAX_MUTED), { id: 'new', name: 'New' });
    expect(muted).toHaveLength(MAX_MUTED);
    expect(muted[muted.length - 1].id).toBe('new');
    expect(isMuted(muted, 'u0')).toBe(false);
  });

  it('mutes once and refreshes the name', () => {
    expect(mutePerson([], ana)).toEqual([ana]);
    expect(mutePerson([ana, bo], { id: 'ana', name: 'Ana M' })).toEqual([bo, { id: 'ana', name: 'Ana M' }]);
    expect(mutePerson([], { id: 'x', name: '' })).toEqual([{ id: 'x', name: 'Someone' }]);
  });

  it('unmutes one person and leaves the rest', () => {
    expect(unmutePerson([ana, bo], 'ana')).toEqual([bo]);
    expect(unmutePerson([ana], 'nobody')).toEqual([ana]);
    expect(isMuted([ana, bo], 'bo')).toBe(true);
    expect(isMuted([ana], 'bo')).toBe(false);
  });
});

function fakeStorage() {
  const items = new Map<string, string>();
  return {
    getItem: (k: string) => items.get(k) ?? null,
    setItem: (k: string, v: string) => { items.set(k, String(v)); },
    removeItem: (k: string) => { items.delete(k); },
    items,
  };
}

describe('muted people in storage', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('saves per person and board, and loads them back', () => {
    const store = fakeStorage();
    vi.stubGlobal('localStorage', store);
    saveMuted('me', 'b1', [{ id: 'ana', name: 'Ana' }]);
    expect(store.items.has('driftboard:focus-muted:me:b1')).toBe(true);
    expect(loadMuted('me', 'b1')).toEqual([{ id: 'ana', name: 'Ana' }]);
    expect(loadMuted('me', 'b2')).toEqual([]);
    expect(loadMuted('you', 'b1')).toEqual([]);
  });

  it('removes the key when the last person is unmuted', () => {
    const store = fakeStorage();
    vi.stubGlobal('localStorage', store);
    saveMuted('me', 'b1', [{ id: 'ana', name: 'Ana' }]);
    saveMuted('me', 'b1', []);
    expect(store.items.size).toBe(0);
  });

  it('mutes nobody and does not throw when storage is blocked', () => {
    const blocked = {
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('blocked'); },
      removeItem: () => { throw new Error('blocked'); },
    };
    vi.stubGlobal('localStorage', blocked);
    expect(loadMuted('me', 'b1')).toEqual([]);
    expect(() => saveMuted('me', 'b1', [{ id: 'ana', name: 'Ana' }])).not.toThrow();
    expect(() => saveMuted('me', 'b1', [])).not.toThrow();
  });

  it('mutes nobody when storage holds junk', () => {
    const store = fakeStorage();
    store.items.set('driftboard:focus-muted:me:b1', '{{{');
    vi.stubGlobal('localStorage', store);
    expect(loadMuted('me', 'b1')).toEqual([]);
  });
});

describe('following', () => {
  const size = { w: 800, h: 600 };

  it('reads a view and rejects junk', () => {
    expect(parseView({ x: 1, y: 2, zoom: 0.5 })).toEqual({ x: 1, y: 2, zoom: 0.5 });
    expect(parseView({ x: 1, y: 2, zoom: 0.5, extra: 1 })).toEqual({ x: 1, y: 2, zoom: 0.5 });
    for (const bad of [null, undefined, 'x', {}, { x: 1, y: 2 }, { x: Number.NaN, y: 2, zoom: 1 }, { x: 1, y: 2, zoom: 0 }, { x: 1e9, y: 2, zoom: 1 }, { x: 1, y: 2, zoom: 65 }]) {
      expect([JSON.stringify(bad), parseView(bad)]).toEqual([JSON.stringify(bad), null]);
    }
  });

  it('turns a view into the camera that centres it, and back', () => {
    const cam = viewToCamera({ x: 500, y: 300, zoom: 2 }, size);
    expect(cam).toEqual({ x: 300, y: 150, zoom: 2 });
    expect(cameraToView(cam, size)).toEqual({ x: 500, y: 300, zoom: 2 });
  });

  it('rounds the view it sends so a tiny drift is not a change', () => {
    expect(cameraToView({ x: 0.0001, y: 0.0004, zoom: 1.000001 }, { w: 100, h: 100 })).toEqual({ x: 50, y: 50, zoom: 1 });
  });

  it('moves only for a change you could see', () => {
    const v = { x: 100, y: 100, zoom: 1 };
    expect(viewDiffers({ ...v }, v)).toBe(false);
    expect(viewDiffers({ ...v, x: 100.4 }, v)).toBe(false);
    expect(viewDiffers({ ...v, x: 101 }, v)).toBe(true);
    expect(viewDiffers({ ...v, y: 98 }, v)).toBe(true);
    expect(viewDiffers({ ...v, zoom: 1.01 }, v)).toBe(true);
    expect(viewDiffers({ x: 100.4, y: 100, zoom: 4 }, { x: 100, y: 100, zoom: 4 })).toBe(true);
  });

  it('tells a camera that is the one it left from one that moved', () => {
    expect(sameCamera({ x: 1, y: 2, zoom: 3 }, { x: 1, y: 2, zoom: 3 })).toBe(true);
    expect(sameCamera({ x: 1, y: 2, zoom: 3 }, { x: 1.0001, y: 2, zoom: 3 })).toBe(false);
    expect(sameCamera({ x: 1, y: 2, zoom: 3 }, { x: 1, y: 2, zoom: 3.5 })).toBe(false);
  });

  it('knows whether another client follows this one', () => {
    const states: [number, unknown][] = [[1, { user: {} }], [2, { following: 1 }], [3, { following: null }], [4, null], [5, 'x']];
    expect(isFollowedBy(states, 1)).toBe(true);
    expect(isFollowedBy(states, 2)).toBe(false);
    expect(isFollowedBy(states, 9)).toBe(false);
    expect(isFollowedBy([[1, { following: 1 }]], 1)).toBe(false);
    expect(isFollowedBy([], 1)).toBe(false);
  });
});
