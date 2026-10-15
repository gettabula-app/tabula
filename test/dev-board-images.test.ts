import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TEMPLATES } from '../src/templates';
import {
  devBoardImage, devBoardImagesReady, loadDevBoardImages, pictureFor, previewPictureFor, refreshDevBoardPreviews, resetDevBoardImagesForTests,
} from '../src/ui/dev-board-images';

// TAB-375 slice 2, dev only: the pictures of the Boards cards. A board shows the picture an editor stored (the relay's dev previews,
// cache-busted by version) and, until it has one, the block picture of the template named in the seed's manifest. A production build
// must not fetch either, nor draw any picture from them.

const TEMPLATE = TEMPLATES[0].id;
const manifest = { 'q4-roadmap': TEMPLATE, 'blank-board': null, ghost: 'no-such-template' };

beforeEach(() => {
  resetDevBoardImagesForTests();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

type Answer = { ok: boolean; json: () => Promise<unknown> } | 'network';

/** A fetch that answers by address: the manifest, the lookup, anything else as a 404. Returns the mock, for counting. */
function route(answers: Record<string, Answer | (() => Answer)>) {
  const fetchMock = vi.fn<(url: string) => Promise<{ ok: boolean; json: () => Promise<unknown> }>>(async (url) => {
    const key = Object.keys(answers).find((k) => url === k || url.startsWith(`${k}?`));
    if (key === undefined) return { ok: false, json: async () => null };
    const answer = typeof answers[key] === 'function' ? (answers[key] as () => Answer)() : answers[key];
    if (answer === 'network') throw new TypeError('network down');
    return answer;
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}
const reply = (body: unknown, ok = true): Answer => ({ ok, json: async () => body });
const urlsOf = (fetchMock: { mock: { calls: unknown[][] } }) => fetchMock.mock.calls.map((c) => String(c[0]));

const LOOKUP = '/api/dev/board-previews';
const MANIFEST = '/dev-board-images/manifest.json';

describe('pictureFor (pure)', () => {
  it('gives a board in the manifest the block picture of its built-in template', () => {
    const picture = pictureFor(manifest, 'q4-roadmap');
    expect(picture?.kind).toBe('svg');
    expect(picture?.kind === 'svg' && picture.markup.startsWith('<svg')).toBe(true);
  });

  it('gives no picture for a board with null, a template that is not built in, a board not listed, or an inherited key', () => {
    expect(pictureFor(manifest, 'blank-board')).toBeUndefined();
    expect(pictureFor(manifest, 'ghost')).toBeUndefined();
    expect(pictureFor(manifest, 'not-listed')).toBeUndefined();
    expect(pictureFor(manifest, 'constructor')).toBeUndefined();
    expect(pictureFor(null, 'q4-roadmap')).toBeUndefined();
  });
});

describe('previewPictureFor (pure)', () => {
  it('gives a listed board its address with the version, so a new version is a new address', () => {
    expect(previewPictureFor({ 'q4-roadmap': 1700000000123 }, 'q4-roadmap')).toEqual({ kind: 'url', src: '/api/dev/board-preview/q4-roadmap?v=1700000000123' });
  });

  it('gives no picture for a board that is not listed, for no lookup, or for an inherited key', () => {
    expect(previewPictureFor({ 'q4-roadmap': 5 }, 'other')).toBeUndefined();
    expect(previewPictureFor(null, 'q4-roadmap')).toBeUndefined();
    expect(previewPictureFor({}, 'constructor')).toBeUndefined();
  });

  it('encodes the board id in the address', () => {
    expect(previewPictureFor({ 'a b': 1 }, 'a b')).toEqual({ kind: 'url', src: '/api/dev/board-preview/a%20b?v=1' });
  });
});

describe('the dev picture guard', () => {
  it('in dev, fetches the manifest once for any number of calls, and then answers at once', async () => {
    vi.stubEnv('DEV', true);
    const fetchMock = route({ [MANIFEST]: reply(manifest), [LOOKUP]: reply({}) });
    await loadDevBoardImages();
    await loadDevBoardImages();
    expect(urlsOf(fetchMock).filter((u) => u === MANIFEST)).toHaveLength(1);
    expect(devBoardImagesReady()).toBe(true);
    expect(devBoardImage('q4-roadmap')?.kind).toBe('svg');
    expect(devBoardImage('not-listed')).toBeUndefined();
  });

  it('in dev, a missing, unreadable or malformed manifest means no pictures from it, and is not fetched again', async () => {
    vi.stubEnv('DEV', true);
    const missing = route({ [MANIFEST]: reply(null, false), [LOOKUP]: reply({}) });
    await loadDevBoardImages();
    expect(devBoardImage('q4-roadmap')).toBeUndefined();
    expect(devBoardImagesReady()).toBe(true);
    await loadDevBoardImages();
    expect(urlsOf(missing).filter((u) => u === MANIFEST)).toHaveLength(1);

    resetDevBoardImagesForTests();
    route({ [MANIFEST]: reply(['not', 'a', 'map']), [LOOKUP]: reply({}) });
    await loadDevBoardImages();
    expect(devBoardImage('q4-roadmap')).toBeUndefined();
  });

  it('in dev, a failed request (no fetch at all, or a network error) also means no pictures, and does not throw', async () => {
    vi.stubEnv('DEV', true);
    route({ [MANIFEST]: 'network', [LOOKUP]: 'network' });
    await expect(loadDevBoardImages()).resolves.toBeUndefined();
    expect(devBoardImage('q4-roadmap')).toBeUndefined();
    expect(devBoardImagesReady()).toBe(true);
  });

  it('in a production build it never fetches and never gives a picture', async () => {
    vi.stubEnv('DEV', false);
    const fetchMock = route({ [MANIFEST]: reply(manifest), [LOOKUP]: reply({ 'q4-roadmap': 1 }) });
    await loadDevBoardImages();
    await refreshDevBoardPreviews();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(devBoardImagesReady()).toBe(true);
    expect(devBoardImage('q4-roadmap')).toBeUndefined();
  });
});

describe('the stored pictures in dev', () => {
  it('a board with a stored picture shows it, and the template picture is only the fallback', async () => {
    vi.stubEnv('DEV', true);
    route({ [MANIFEST]: reply(manifest), [LOOKUP]: reply({ 'q4-roadmap': 42 }) });
    await loadDevBoardImages();
    expect(devBoardImage('q4-roadmap')).toEqual({ kind: 'url', src: '/api/dev/board-preview/q4-roadmap?v=42' });
    // not stored yet: the manifest's template picture
    expect(devBoardImage('blank-board')).toBeUndefined();
    route({ [MANIFEST]: reply(manifest), [LOOKUP]: reply({}) });
    await refreshDevBoardPreviews();
    expect(devBoardImage('q4-roadmap')?.kind).toBe('svg');
  });

  it('a lookup that is not ok, or not a map of versions, means no stored pictures (the manifest still applies)', async () => {
    vi.stubEnv('DEV', true);
    route({ [MANIFEST]: reply(manifest), [LOOKUP]: reply(null, false) });
    await loadDevBoardImages();
    expect(devBoardImage('q4-roadmap')?.kind).toBe('svg');

    resetDevBoardImagesForTests();
    route({ [MANIFEST]: reply(manifest), [LOOKUP]: reply({ 'q4-roadmap': 'yesterday' }) });
    await loadDevBoardImages();
    expect(devBoardImage('q4-roadmap')?.kind).toBe('svg');
  });

  it('a refresh asks the lookup again, so a board edited since the last page render shows its new version', async () => {
    vi.stubEnv('DEV', true);
    let version = 10;
    const fetchMock = route({ [MANIFEST]: reply(manifest), [LOOKUP]: () => reply({ 'q4-roadmap': version }) });
    await loadDevBoardImages();
    expect(devBoardImage('q4-roadmap')).toEqual({ kind: 'url', src: '/api/dev/board-preview/q4-roadmap?v=10' });
    version = 11;
    await refreshDevBoardPreviews();
    expect(devBoardImage('q4-roadmap')).toEqual({ kind: 'url', src: '/api/dev/board-preview/q4-roadmap?v=11' });
    expect(urlsOf(fetchMock).filter((u) => u === LOOKUP)).toHaveLength(2);
    expect(urlsOf(fetchMock).filter((u) => u === MANIFEST)).toHaveLength(1);
  });

  it('a refresh that fails leaves no stored pictures rather than the last ones', async () => {
    vi.stubEnv('DEV', true);
    let fail = false;
    route({ [MANIFEST]: reply(manifest), [LOOKUP]: () => (fail ? 'network' : reply({ 'q4-roadmap': 3 })) });
    await loadDevBoardImages();
    expect(devBoardImage('q4-roadmap')?.kind).toBe('url');
    fail = true;
    await refreshDevBoardPreviews();
    expect(devBoardImage('q4-roadmap')?.kind).toBe('svg');
  });
});
