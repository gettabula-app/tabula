import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PICTURE_MAX_BYTES, rasterizePicture, type RasterCanvas, type RasterDeps } from '../src/preview-raster';

// The encoding of a board picture (src/preview-raster.ts). The SVG is handed to an image as a blob: URL and never inserted into the page;
// the canvas and the image are stubbed here, so the test can see exactly what would be loaded and drawn.

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="300"/>';

function blob(type: string, size: number): Blob {
  return new Blob([new Uint8Array(size)], { type });
}

function fakeDeps(encodings: Record<string, number | null> = { 'image/webp:0.8': 9000 }) {
  const loaded: string[] = [];
  const drawn: unknown[] = [];
  const calls: string[] = [];
  const image = { picture: true } as unknown as CanvasImageSource;
  const canvas: RasterCanvas = {
    context: () => ({
      fillStyle: '',
      fillRect: () => calls.push('fillRect'),
      drawImage: (img, x, y, w, h) => {
        drawn.push({ img, x, y, w, h });
        calls.push('drawImage');
      },
    }),
    toBlob: async (type, quality) => {
      const key = `${type}:${quality ?? ''}`;
      calls.push(`toBlob ${key}`);
      const size = encodings[key] ?? null;
      return size === null ? null : blob(type, size);
    },
  };
  const deps: RasterDeps = {
    loadImage: async (url) => {
      loaded.push(url);
      return image;
    },
    makeCanvas: () => canvas,
  };
  return { deps, loaded, drawn, calls, image };
}

beforeEach(() => {
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:https://tabula.test/picture-1');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('rasterizePicture', () => {
  it('loads the picture only as a blob: URL, draws it on a white 480 x 300 canvas, and releases the URL', async () => {
    const { deps, loaded, drawn, image } = fakeDeps();
    const out = await rasterizePicture(SVG, deps);
    expect(out?.type).toBe('image/webp');
    expect(loaded).toEqual(['blob:https://tabula.test/picture-1']);
    expect(URL.createObjectURL).toHaveBeenCalledWith(expect.objectContaining({ type: 'image/svg+xml' }));
    expect(drawn).toEqual([{ img: image, x: 0, y: 0, w: 480, h: 300 }]);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:https://tabula.test/picture-1');
  });

  it('keeps the first WebP that fits, lowering the quality step by step', async () => {
    const { deps, calls } = fakeDeps({ 'image/webp:0.8': 60_000, 'image/webp:0.6': 41_000, 'image/webp:0.4': 30_000 });
    const out = await rasterizePicture(SVG, deps);
    expect(out?.type).toBe('image/webp');
    expect(out!.size).toBe(30_000);
    expect(calls.filter((c) => c.startsWith('toBlob'))).toEqual(['toBlob image/webp:0.8', 'toBlob image/webp:0.6', 'toBlob image/webp:0.4']);
  });

  it('falls back to PNG when no WebP quality fits, and refuses a PNG that is still too large', async () => {
    const png = fakeDeps({ 'image/webp:0.8': 90_000, 'image/webp:0.6': 90_000, 'image/webp:0.4': 90_000, 'image/png:': 20_000 });
    expect((await rasterizePicture(SVG, png.deps))?.type).toBe('image/png');
    const tooBig = fakeDeps({ 'image/webp:0.8': 90_000, 'image/webp:0.6': 90_000, 'image/webp:0.4': 90_000, 'image/png:': PICTURE_MAX_BYTES + 1 });
    expect(await rasterizePicture(SVG, tooBig.deps)).toBeNull();
  });

  it('never returns more than the cap, and an encoder that answers another type is not used', async () => {
    const encoder = fakeDeps({ 'image/webp:0.8': PICTURE_MAX_BYTES, 'image/webp:0.6': null, 'image/webp:0.4': null });
    const kept = await rasterizePicture(SVG, encoder.deps);
    expect(kept!.size).toBeLessThanOrEqual(PICTURE_MAX_BYTES);
    const wrongType: RasterDeps = {
      loadImage: async () => ({} as CanvasImageSource),
      makeCanvas: () => ({
        context: () => ({ fillStyle: '', fillRect: () => {}, drawImage: () => {} }),
        toBlob: async (type) => blob(type === 'image/webp' ? 'image/png' : type, 100),
      }),
    };
    expect((await rasterizePicture(SVG, wrongType))?.type).toBe('image/png');
  });

  it('gives nothing when the picture cannot be loaded or drawn, and still releases its URL', async () => {
    const failing: RasterDeps = { loadImage: async () => { throw new Error('bad picture'); }, makeCanvas: () => { throw new Error('no canvas'); } };
    expect(await rasterizePicture(SVG, failing)).toBeNull();
    expect(URL.revokeObjectURL).toHaveBeenCalled();
    const noContext = fakeDeps();
    noContext.deps.makeCanvas = () => ({ context: () => null, toBlob: async () => blob('image/webp', 10) });
    expect(await rasterizePicture(SVG, noContext.deps)).toBeNull();
  });
});

describe('an encoder that gives nothing (Safari has no WebP, and its PNG is too large)', () => {
  it('returns null with no throw, draws the picture once, and releases its URL', async () => {
    const { deps, calls } = fakeDeps({});
    await expect(rasterizePicture(SVG, deps)).resolves.toBeNull();
    expect(calls.filter((c) => c === 'drawImage')).toHaveLength(1);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:https://tabula.test/picture-1');
  });

  it('a canvas whose toBlob answers null for every type gives nothing, whatever it is asked for', async () => {
    const asked: string[] = [];
    const canvas: RasterCanvas = {
      context: () => ({ fillStyle: '', fillRect: () => undefined, drawImage: () => undefined }),
      toBlob: async (type) => {
        asked.push(type);
        return null;
      },
    };
    const deps: RasterDeps = { loadImage: async () => ({} as CanvasImageSource), makeCanvas: () => canvas };
    await expect(rasterizePicture(SVG, deps)).resolves.toBeNull();
    expect(asked).toContain('image/png');
  });
});
