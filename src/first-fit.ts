import type { Renderer } from './render';
import type { Store } from './store';
import { LOCAL } from './store';
import type { Rect } from './types';

/** How long after opening a board its first content may still move the camera: the time the first sync can take. */
export const FIRST_FIT_WINDOW_MS = 15_000;

/**
 * The first view of a board. When the board opens with content it is fitted once, at the next frame. A board that is empty
 * then (a relay still syncing, a slow connection) is fitted once when its first content arrives from elsewhere, within
 * the sync window, as long as the person has not moved or zoomed the camera. Their own first edit, a camera they moved
 * and the end of the window all end the wait, so the view never jumps under someone who is working.
 */
export function watchFirstFit(
  store: Pick<Store, 'onChange'>,
  r: Pick<Renderer, 'cam' | 'contentBounds' | 'fitFirst' | 'setCamera' | 'size'>,
  now: () => number = Date.now,
) {
  const openedAt = now();
  let done = false;
  let auto = { ...r.cam };
  const moved = () => r.cam.x !== auto.x || r.cam.y !== auto.y || r.cam.zoom !== auto.zoom;
  const remember = () => { auto = { ...r.cam }; };
  const fit = (b: Rect) => {
    r.fitFirst(b);
    remember();
    done = true;
  };
  const offStore = store.onChange((_changed, origin) => {
    if (done) return;
    if (origin === LOCAL || now() - openedAt > FIRST_FIT_WINDOW_MS || moved()) {
      done = true;
      return;
    }
    const b = r.contentBounds();
    if (b) fit(b);
  });
  return {
    /** Run at the first frame after the board is built. */
    start() {
      if (done) return;
      const b = r.contentBounds();
      if (b) {
        fit(b);
        return;
      }
      const s = r.size();
      r.setCamera({ x: -s.w / 2, y: -s.h / 2, zoom: 1 });
      remember();
    },
    dispose() {
      done = true;
      offStore();
    },
  };
}
