// Draws a board picture (an SVG string already passed through the whitelist, src/preview-svg-safe.ts) onto a canvas and encodes it. The SVG
// is never inserted into the page: it becomes a blob: URL, loaded by an <img> that is not attached to the document, drawn, and released.
// An SVG loaded as an image cannot reach the network, and the canvas stays untainted, because the picture has no external resource.
import { PICTURE_H, PICTURE_W } from './preview-render';

/** What a stored picture may weigh: the server's cap (server/preview-image.mjs MAX_PREVIEW_BYTES). */
export const PICTURE_MAX_BYTES = 40_960;
/** The encodings tried in order: WebP at falling quality, then PNG. The first one under the cap is kept. */
const WEBP_QUALITIES = [0.8, 0.6, 0.4];

export interface RasterDeps {
  /** Loads a blob: URL into an image that is drawn. */
  loadImage: (url: string) => Promise<CanvasImageSource>;
  makeCanvas: (width: number, height: number) => RasterCanvas;
}

export interface RasterCanvas {
  context(): { fillStyle: string | object; fillRect(x: number, y: number, w: number, h: number): void; drawImage(img: CanvasImageSource, x: number, y: number, w: number, h: number): void } | null;
  toBlob(type: string, quality?: number): Promise<Blob | null>;
}

/** The browser's own: an image in a detached element, and a detached canvas. Only used in the browser. */
export const browserRasterDeps: () => RasterDeps = () => ({
  loadImage: (url) => new Promise<CanvasImageSource>((resolve, reject) => {
    const img = new Image(PICTURE_W, PICTURE_H);
    img.decoding = 'sync';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('the picture did not load'));
    img.src = url;
  }),
  makeCanvas: (width, height) => {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return {
      context: () => canvas.getContext('2d'),
      toBlob: (type, quality) => new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality)),
    };
  },
});

/**
 * The picture as an encoded image no larger than PICTURE_MAX_BYTES: WebP (the first quality that fits), else PNG. Null when neither fits
 * or the picture cannot be drawn. The blob: URL is released in every case.
 */
export async function rasterizePicture(svg: string, deps: RasterDeps = browserRasterDeps()): Promise<Blob | null> {
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    const img = await deps.loadImage(url);
    const canvas = deps.makeCanvas(PICTURE_W, PICTURE_H);
    const ctx = canvas.context();
    if (!ctx) return null;
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, PICTURE_W, PICTURE_H);
    ctx.drawImage(img, 0, 0, PICTURE_W, PICTURE_H);
    for (const quality of WEBP_QUALITIES) {
      const blob = await canvas.toBlob('image/webp', quality);
      if (blob && blob.type === 'image/webp' && blob.size <= PICTURE_MAX_BYTES) return blob;
    }
    const png = await canvas.toBlob('image/png');
    return png && png.type === 'image/png' && png.size <= PICTURE_MAX_BYTES ? png : null;
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}
