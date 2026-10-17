// DEV ONLY. Gives the seeded boards their pictures at launch (scripts/dev-boards-real.mjs). A seeded board holds real content but no
// picture yet, so the first load of the Boards page would show quiet tiles. This opens each board in a browser as its owner and leaves it:
// the app's own client render (src/ui/board-preview-sync.ts) then sends the picture through the real upload route, the same as an
// editor leaving a board does. Nothing is drawn or stored here. Without a browser the warm-up is skipped and the cards show the quiet tile
// until each board is opened and left.
//
// The owner signs in with a token of its own (the seed's smoke token), so the links the launcher prints stay single use for their people.
import { chromium } from 'playwright';

const UPLOAD_TIMEOUT_MS = 60_000;

/** The session cookie the app would hold after the sign-in link: the token is exchanged once, the way the sign-in page does it. */
export async function sessionCookie(origin, token) {
  const res = await fetch(`${origin}/api/auth/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', 'x-tabula': '1' },
    body: JSON.stringify({ token }),
  });
  const set = res.headers.getSetCookie?.()[0] ?? '';
  const pair = set.split(';')[0] ?? '';
  const eq = pair.indexOf('=');
  if (!res.ok || eq < 1) throw new Error(`the owner's sign-in did not work (${res.status})`);
  return { name: pair.slice(0, eq), value: pair.slice(eq + 1) };
}

/**
 * Opens and leaves each board, one at a time, and reports which pictures reached the server. Never throws: a board that fails is listed.
 * @param {{ origin: string, token: string, boardIds: string[], log?: (line: string) => void }} input
 * @returns {Promise<{ stored: string[], failed: string[], skipped: string | null }>}
 */
export async function warmBoardPictures({ origin, token, boardIds, log = () => {} }) {
  const stored = [];
  const failed = [];
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (err) {
    const reason = `no browser for the picture warm-up (${String(err?.message ?? err).split('\n')[0]})`;
    log(`${reason}: the boards show the quiet tile until each is opened and left`);
    return { stored, failed: boardIds, skipped: reason };
  }
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    await context.addCookies([{ ...(await sessionCookie(origin, token)), url: origin }]);
    const page = await context.newPage();
    for (const id of boardIds) {
      const uploaded = page.waitForResponse(
        (r) => r.request().method() === 'PUT' && new URL(r.url()).pathname === `/api/boards/${encodeURIComponent(id)}/preview`,
        { timeout: UPLOAD_TIMEOUT_MS },
      ).catch(() => null);
      try {
        await page.goto(`${origin}/?debug#/b/${encodeURIComponent(id)}`, { waitUntil: 'domcontentloaded', timeout: UPLOAD_TIMEOUT_MS });
        // the board this page now shows has its content (window.__board is left over from the board before it until this one is mounted)
        await page.waitForFunction((boardId) => window.__board?.conn?.id === boardId && window.__board.store.cache.size > 0, id, { timeout: UPLOAD_TIMEOUT_MS });
        await page.evaluate(() => { location.hash = '#/'; });
        const answer = await uploaded;
        if (answer && answer.status() === 204) stored.push(id);
        else failed.push(id);
      } catch {
        failed.push(id);
      }
      await page.waitForTimeout(500);
    }
    log(`pictures: ${stored.length} stored${failed.length ? `, ${failed.length} not (${failed.join(', ')})` : ''}`);
  } finally {
    await browser.close();
  }
  return { stored, failed, skipped: null };
}
