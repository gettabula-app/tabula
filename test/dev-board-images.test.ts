import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TEMPLATES } from '../src/templates';
import { devBoardImage, devBoardImagesReady, loadDevBoardImages, pictureFor, resetDevBoardImagesForTests } from '../src/ui/dev-board-images';

// TAB-375 slice 2, dev only: the real pictures of the Boards cards come from a manifest (board id to built-in template id). A production
// build must not fetch it or draw any picture from it.

const TEMPLATE = TEMPLATES[0].id;
const manifest = { 'q4-roadmap': TEMPLATE, 'blank-board': null, ghost: 'no-such-template' };

beforeEach(() => {
  resetDevBoardImagesForTests();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function serve(body: unknown, ok = true) {
  const fetchMock = vi.fn<(url: string, init?: unknown) => Promise<{ ok: boolean; json: () => Promise<unknown> }>>(async () => ({ ok, json: async () => body }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

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

describe('the dev picture guard', () => {
  it('in dev, fetches the manifest once for any number of calls, and then answers at once', async () => {
    vi.stubEnv('DEV', true);
    const fetchMock = serve(manifest);
    await loadDevBoardImages();
    await loadDevBoardImages();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('/dev-board-images/manifest.json');
    expect(devBoardImagesReady()).toBe(true);
    expect(devBoardImage('q4-roadmap')?.kind).toBe('svg');
    expect(devBoardImage('not-listed')).toBeUndefined();
  });

  it('in dev, a missing, unreadable or malformed manifest means no pictures, and is not fetched again', async () => {
    vi.stubEnv('DEV', true);
    const missing = serve(null, false);
    await loadDevBoardImages();
    expect(devBoardImage('q4-roadmap')).toBeUndefined();
    expect(devBoardImagesReady()).toBe(true);
    expect(missing).toHaveBeenCalledTimes(1);
    await loadDevBoardImages();
    expect(missing).toHaveBeenCalledTimes(1);

    resetDevBoardImagesForTests();
    serve(['not', 'a', 'map']);
    await loadDevBoardImages();
    expect(devBoardImage('q4-roadmap')).toBeUndefined();
  });

  it('in dev, a failed request (no fetch at all, or a network error) also means no pictures, and does not throw', async () => {
    vi.stubEnv('DEV', true);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('network down'); }));
    await expect(loadDevBoardImages()).resolves.toBeUndefined();
    expect(devBoardImage('q4-roadmap')).toBeUndefined();
  });

  it('in a production build it never fetches and never gives a picture', async () => {
    vi.stubEnv('DEV', false);
    const fetchMock = serve(manifest);
    await loadDevBoardImages();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(devBoardImagesReady()).toBe(true);
    expect(devBoardImage('q4-roadmap')).toBeUndefined();
  });
});
