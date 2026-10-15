// The bare page of test/preview-bare-browser.test.ts: the picture modules and nothing else (no board.ts, so no app fonts, styles or
// requests). It exposes one function that draws the picture the way the production hook does: the board's images, then the SVG, then the
// encoded picture.
import { buildPictureSvg, embedImages } from '../src/preview-render';
import { rasterizePicture } from '../src/preview-raster';
import type { Obj } from '../src/types';

export async function runPicture(objects: Obj[], boardId: string) {
  const images = await embedImages(objects, boardId, (url, signal) => fetch(url, { credentials: 'same-origin', redirect: 'error', signal }));
  const { svg, mode, reason } = buildPictureSvg(objects, { images });
  const blob = await rasterizePicture(svg);
  return {
    mode,
    reason,
    images: [...images.keys()],
    imageTypes: [...images.values()].map((url) => url.slice(5, url.indexOf(';'))),
    imageBytes: [...images.values()].map((url) => url.length),
    blob: blob ? { type: blob.type, size: blob.size, bytes: Array.from(new Uint8Array(await blob.arrayBuffer())) } : null,
  };
}

(window as unknown as { runPicture: typeof runPicture }).runPicture = runPicture;
