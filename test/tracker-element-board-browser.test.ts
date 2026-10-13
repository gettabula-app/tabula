import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { existsSync } from 'node:fs';
import { createServer, type ViteDevServer } from 'vite';
import { budget } from './wait-budget';

// The Board tab of the tracker element, in a real browser: lanes by width (three at 720, two at 480), a card dragged from one lane to
// another (pointer based, with the element's scale), Escape cancelling, a read-only person's board with no drag and no '+', Undo, a
// failed move reverting with a message, the long press of a touch, and a drag on a live element on a zoomed board that never pans the
// camera. The standalone element is mounted like a board frame does (element mode, layout width, optional scale transform).

let server: ViteDevServer | undefined;
let browser: Browser | undefined;
let base = '';
const available = existsSync(chromium.executablePath());

beforeAll(async () => {
  if (!available) return;
  server = await createServer({ configFile: false, root: process.cwd(), mode: 'visual', logLevel: 'error', server: { host: '127.0.0.1', port: 0 } });
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === 'string') throw new Error('Vite did not open a TCP port');
  base = `http://127.0.0.1:${address.port}/`;
  browser = await chromium.launch({ headless: true });
}, 300_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

/** A page with the app's styles and `__mount(width, scale, readOnly)`: the element starts on the Board tab. */
async function openBoardPage(viewportWidth = 1100, touch = false): Promise<Page> {
  const context = await browser!.newContext({ viewport: { width: viewportWidth, height: 800 }, hasTouch: touch });
  const page = await context.newPage();
  page.setDefaultTimeout(budget(45_000));
  await page.goto(`${base}?element-look`);
  await page.addScriptTag({
    type: 'module',
    content: `
      import '/src/styles.css';
      import { mountTrackerShell } from '/src/tracker/ui/shell.ts';
      import { createTrackerStore } from '/src/tracker-data.ts';
      import { createMockTrackerApi } from '/src/tracker-mock.ts';
      import { createTrackerVisualSeed } from '/src/tracker/ui/visual-seed.ts';
      window.__mount = async (width, scale = 1, readOnly = false) => {
        window.__shell?.destroy();
        document.querySelector('#element-host')?.remove();
        // the harness page has other content above the element: hide it so the element sits at the top of the viewport
        for (const child of [...document.body.children]) if (child.id !== 'element-host') child.style.display = 'none';
        const host = document.createElement('div');
        host.id = 'element-host';
        host.style.cssText = 'position:fixed;left:20px;top:20px;';
        document.body.appendChild(host);
        const api = createMockTrackerApi(createTrackerVisualSeed());
        const store = createTrackerStore(api, { isVisible: () => false });
        window.__api = api;
        window.__store = store;
        const card = document.createElement('div');
        card.style.cssText = 'position:relative;';
        host.appendChild(card);
        window.__shell = mountTrackerShell(card, {
          store, api, viewerId: 'element-board', trackerId: 'tracker-demo', windowId: 'element-board-1', element: true,
          initialTab: 'board', layoutWidth: width, boardName: 'Board', readOnly,
        });
        window.__shell.el.style.width = width + 'px';
        window.__shell.el.style.height = '480px';
        if (scale !== 1) { window.__shell.el.style.transformOrigin = 'top left'; window.__shell.el.style.transform = 'scale(' + scale + ')'; }
        await store.loadMeta();
      };
    `,
  });
  await page.waitForFunction(() => typeof (window as any).__mount === 'function', null, { timeout: budget(60_000) });
  return page;
}

async function mount(page: Page, width: number, scale = 1, readOnly = false): Promise<void> {
  await page.evaluate(([w, s, r]) => (window as any).__mount(w, s, r), [width, scale, readOnly] as const);
  await page.locator('.trk-element-header').waitFor();
  // every lane has loaded: ten cards (the seed's twelve less the two cancelled)
  await page.waitForFunction(() => document.querySelectorAll('.trk-element .trk-board-card').length === 10, null, { timeout: budget(15_000) });
}

const stateOf = (page: Page, key: string) => page.evaluate((k) => (window as any).__store.ticket(k).ticket?.state.key as string | undefined, key);

/** The visible lanes: a lane counts when its box sits inside the strip that scrolls it. */
const visibleLanes = (page: Page) => page.evaluate(() => {
  const strip = document.querySelector('.trk-element .trk-board-lanes')!.getBoundingClientRect();
  return [...document.querySelectorAll<HTMLElement>('.trk-element .trk-board-lane')]
    .filter((lane) => { const r = lane.getBoundingClientRect(); return r.left >= strip.left - 0.5 && r.right <= strip.right + 0.5; })
    .map((lane) => lane.dataset.state);
});

const laneCentre = (page: Page, state: string) => page.evaluate((s) => {
  const r = document.querySelector<HTMLElement>(`.trk-element .trk-board-lane[data-state="${s}"]`)!.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 3 };
}, state);

const cardCentre = (page: Page, key: string) => page.evaluate((k) => {
  const r = document.querySelector<HTMLElement>(`.trk-element .trk-board-card[data-key="${k}"]`)!.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}, key);

/** A mouse drag from the card to the lane's centre, in steps, optionally cancelled with Escape before the release. */
async function dragWithMouse(page: Page, key: string, state: string, options: { escape?: boolean } = {}): Promise<void> {
  const from = await cardCentre(page, key);
  const to = await laneCentre(page, state);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 6, from.y + 2, { steps: 2 });
  await page.mouse.move(to.x, to.y, { steps: 12 });
  if (options.escape) await page.keyboard.press('Escape');
  await page.mouse.up();
}

const ghostCount = (page: Page) => page.evaluate(() => document.querySelectorAll('.trk-element .trk-board-ghost').length);

describe.skipIf(!available)('tracker element board tab in a real browser', { timeout: 300_000 }, () => {
  it('shows the lanes without the board view bar; three lanes at 720 and two at 480', async () => {
    const page = await openBoardPage();
    try {
      await mount(page, 720);
      expect(await page.locator('.trk-element .trk-board-viewbar').count()).toBe(0);
      expect(await page.locator('.trk-element .trk-element-switch .segmented button.on').textContent()).toBe('Board');
      expect((await visibleLanes(page)).length).toBe(3);
      expect(await page.locator('.trk-element .trk-board-lane[data-state="todo"] .trk-board-card').count()).toBe(3);
      await mount(page, 480);
      expect((await visibleLanes(page)).length).toBe(2);
    } finally {
      await page.context().close();
    }
  });

  it('the "Board" option fits inside the switch (the label is not wider than its segment) at 720, 480 and 400', async () => {
    const page = await openBoardPage();
    try {
      for (const width of [720, 480, 400]) {
        await mount(page, width);
        const fit = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.trk-element .trk-element-switch .segmented button')].map((b) => ({
          label: b.textContent, overflow: b.scrollWidth - b.clientWidth, width: b.getBoundingClientRect().width,
        })));
        expect(fit.map((b) => b.label)).toEqual(['All', 'My', 'Board']);
        for (const b of fit) expect(b.overflow).toBeLessThanOrEqual(0);
        expect(fit[2].width).toBeGreaterThanOrEqual(44);
      }
    } finally {
      await page.context().close();
    }
  });

  it('every lane runs to the bottom of the body, so the whole column is a drop target', async () => {
    const page = await openBoardPage();
    try {
      await mount(page, 720);
      const gaps = await page.evaluate(() => {
        const strip = document.querySelector<HTMLElement>('.trk-element .trk-board-lanes')!;
        const style = getComputedStyle(strip);
        const bottom = strip.getBoundingClientRect().bottom - Number.parseFloat(style.paddingBottom) - Number.parseFloat(style.borderBottomWidth);
        return [...document.querySelectorAll<HTMLElement>('.trk-element .trk-board-lane')].map((lane) => Math.abs(lane.getBoundingClientRect().bottom - bottom));
      });
      expect(gaps.length).toBeGreaterThan(2);
      for (const gap of gaps) expect(gap).toBeLessThanOrEqual(2);
    } finally {
      await page.context().close();
    }
  });

  it('drags a card from To do to In progress: the card moves, the store changes, one undo is recorded', async () => {
    const page = await openBoardPage();
    try {
      await mount(page, 720);
      expect(await stateOf(page, 'TAB-101')).toBe('todo');
      await dragWithMouse(page, 'TAB-101', 'in_progress');
      await page.locator('.trk-element .trk-board-lane[data-state="in_progress"] .trk-board-card[data-key="TAB-101"]').waitFor();
      await page.waitForFunction(() => (window as any).__store.ticket('TAB-101').ticket?.state.key === 'in_progress', null, { timeout: budget(10_000) });
      expect(await ghostCount(page)).toBe(0);
      expect(await page.locator('.trk-element .trk-board-lane.is-drop-target').count()).toBe(0);
      expect(await page.locator('.toast').textContent()).toContain('State changed');
      // Undo restores the state
      await page.locator('.toast-action', { hasText: 'Undo' }).click();
      await page.waitForFunction(() => (window as any).__store.ticket('TAB-101').ticket?.state.key === 'todo', null, { timeout: budget(10_000) });
      await page.locator('.trk-element .trk-board-lane[data-state="todo"] .trk-board-card[data-key="TAB-101"]').waitFor();
    } finally {
      await page.context().close();
    }
  });

  it('releasing over the card\'s own lane, or pressing Escape during a drag, changes nothing', async () => {
    const page = await openBoardPage();
    try {
      await mount(page, 720);
      await dragWithMouse(page, 'TAB-101', 'in_progress', { escape: true });
      expect(await stateOf(page, 'TAB-101')).toBe('todo');
      expect(await ghostCount(page)).toBe(0);
      // a drag released over the lane it started in cancels too
      const start = await cardCentre(page, 'TAB-101');
      const own = await laneCentre(page, 'todo');
      await page.mouse.move(start.x, start.y);
      await page.mouse.down();
      await page.mouse.move(own.x, own.y, { steps: 10 });
      await page.mouse.up();
      expect(await stateOf(page, 'TAB-101')).toBe('todo');
      expect(await page.locator('.trk-element-back').isVisible()).toBe(false); // no click opened the ticket
      // a press and release on a card without a drag is a click: it opens the ticket
      const card = await cardCentre(page, 'TAB-102');
      await page.mouse.move(card.x, card.y);
      await page.mouse.down();
      await page.mouse.up();
      await page.locator('.trk-element-back').waitFor({ timeout: budget(10_000) });
    } finally {
      await page.context().close();
    }
  });

  it('a drag held within 32px of the lane strip\'s right edge scrolls the strip sideways', async () => {
    const page = await openBoardPage();
    try {
      await mount(page, 480);
      const from = await cardCentre(page, 'TAB-101');
      const edge = await page.evaluate(() => {
        const r = document.querySelector<HTMLElement>('.trk-element .trk-board-lanes')!.getBoundingClientRect();
        return { x: r.right - 6, y: r.top + r.height / 2 };
      });
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move(from.x + 6, from.y + 2, { steps: 2 });
      await page.mouse.move(edge.x, edge.y, { steps: 6 });
      await page.waitForTimeout(500);
      const scrolled = await page.evaluate(() => document.querySelector<HTMLElement>('.trk-element .trk-board-lanes')!.scrollLeft);
      await page.keyboard.press('Escape');
      await page.mouse.up();
      expect(scrolled).toBeGreaterThan(0);
      expect(await stateOf(page, 'TAB-101')).toBe('todo');
    } finally {
      await page.context().close();
    }
  });

  it('a read-only person has no drag, no ghost, no New issue button in the lanes and no card menu', async () => {
    const page = await openBoardPage();
    try {
      await mount(page, 720, 1, true);
      expect(await page.locator('.trk-element .trk-board-add').count()).toBe(0);
      expect(await page.locator('.trk-element .trk-board-menu-button').count()).toBe(0);
      expect(await page.locator('.trk-element .trk-board-card.is-draggable').count()).toBe(0);
      const cursor = await page.evaluate(() => getComputedStyle(document.querySelector('.trk-element .trk-board-card')!).cursor);
      expect(cursor).not.toBe('grab');
      await dragWithMouse(page, 'TAB-101', 'in_progress');
      expect(await ghostCount(page)).toBe(0);
      await page.waitForTimeout(150);
      expect(await stateOf(page, 'TAB-101')).toBe('todo');
    } finally {
      await page.context().close();
    }
  });

  it('a person who can write has a quiet + in each lane that creates in that state, and the card menu moves a card with the picker (and Undo restores it)', async () => {
    const page = await openBoardPage();
    try {
      await mount(page, 720);
      expect(await page.locator('.trk-element .trk-board-add').count()).toBe(4);
      expect(await page.locator('.trk-element .trk-board-add[aria-label="New ticket in In progress"]').count()).toBe(1);
      await page.locator('.trk-element .trk-board-card[data-key="TAB-101"] .trk-board-menu-button').click();
      await page.locator('[role="listbox"][aria-label="Move TAB-101 to"]').waitFor();
      await page.locator('[role="listbox"][aria-label="Move TAB-101 to"] [role="option"]', { hasText: 'In progress' }).click();
      await page.waitForFunction(() => (window as any).__store.ticket('TAB-101').ticket?.state.key === 'in_progress', null, { timeout: budget(10_000) });
      await page.locator('.toast-action', { hasText: 'Undo' }).click();
      await page.waitForFunction(() => (window as any).__store.ticket('TAB-101').ticket?.state.key === 'todo', null, { timeout: budget(10_000) });
    } finally {
      await page.context().close();
    }
  });

  it('a failed move shows the message and returns the card to its lane; the card is in the new lane while the store works', async () => {
    const page = await openBoardPage();
    try {
      await mount(page, 720);
      await page.evaluate(() => {
        const api = (window as any).__api;
        api.transitionTicket = () => new Promise((_, reject) => setTimeout(() => reject(new Error('offline')), 600));
      });
      await dragWithMouse(page, 'TAB-101', 'in_progress');
      await page.locator('.trk-element .trk-board-lane[data-state="in_progress"] .trk-board-card[data-key="TAB-101"]').waitFor({ timeout: budget(2_000) });
      await page.locator('.toast', { hasText: 'Could not move the ticket.' }).waitFor({ timeout: budget(10_000) });
      await page.locator('.trk-element .trk-board-lane[data-state="todo"] .trk-board-card[data-key="TAB-101"]').waitFor();
      expect(await page.locator('.trk-element .trk-board-lane[data-state="in_progress"] .trk-board-card[data-key="TAB-101"]').count()).toBe(0);
    } finally {
      await page.context().close();
    }
  });

  it('a real touch: a press that rests 300 ms and then moves drags the card; a quick swipe on a card does not drag it', async () => {
    const page = await openBoardPage(1100, true);
    try {
      await mount(page, 720);
      const cdp = await page.context().newCDPSession(page);
      const start = await cardCentre(page, 'TAB-101');
      const to = await laneCentre(page, 'in_progress');
      const touchAt = (type: string, x: number, y: number) => cdp.send('Input.dispatchTouchEvent', {
        type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }],
      } as any);
      // a quick swipe: the card is not dragged and the ticket is not changed
      await touchAt('touchStart', start.x, start.y);
      for (let step = 1; step <= 6; step++) await touchAt('touchMove', start.x, start.y + step * 8);
      await touchAt('touchEnd', start.x, start.y + 48);
      await page.waitForTimeout(400);
      expect(await ghostCount(page)).toBe(0);
      expect(await stateOf(page, 'TAB-101')).toBe('todo');
      // a long press: rest, then move over In progress and lift
      await touchAt('touchStart', start.x, start.y);
      await page.waitForTimeout(450);
      for (let step = 1; step <= 8; step++) {
        await touchAt('touchMove', start.x + ((to.x - start.x) * step) / 8, start.y + ((to.y - start.y) * step) / 8);
        await page.waitForTimeout(16);
      }
      expect(await ghostCount(page)).toBe(1);
      await touchAt('touchEnd', to.x, to.y);
      await page.waitForFunction(() => (window as any).__store.ticket('TAB-101').ticket?.state.key === 'in_progress', null, { timeout: budget(10_000) });
    } finally {
      await page.context().close();
    }
  });

  it('a touch drags only after a 300 ms press; a quick move scrolls and drags nothing', async () => {
    const page = await openBoardPage();
    try {
      await mount(page, 720);
      const touch = (type: string, key: string, x: number, y: number, id = 9) => page.evaluate(([t, k, px, py, pid]) => {
        const card = document.querySelector(`.trk-element .trk-board-card[data-key="${k}"]`)!;
        card.dispatchEvent(new PointerEvent(t, { bubbles: true, cancelable: true, clientX: px, clientY: py, pointerId: pid, pointerType: 'touch', isPrimary: true, button: 0 }));
      }, [type, key, x, y, id] as const);
      const start = await cardCentre(page, 'TAB-101');
      // quick: a move of 20px before the press has rested 300 ms is a scroll
      await touch('pointerdown', 'TAB-101', start.x, start.y);
      await touch('pointermove', 'TAB-101', start.x, start.y + 20);
      await touch('pointerup', 'TAB-101', start.x, start.y + 20);
      await page.waitForTimeout(400);
      expect(await ghostCount(page)).toBe(0);
      expect(await stateOf(page, 'TAB-101')).toBe('todo');
      // long press: rest 350 ms, then move over In progress and lift
      const to = await laneCentre(page, 'in_progress');
      await touch('pointerdown', 'TAB-101', start.x, start.y, 10);
      await page.waitForTimeout(350);
      await touch('pointermove', 'TAB-101', to.x, to.y, 10);
      expect(await ghostCount(page)).toBe(1);
      await touch('pointerup', 'TAB-101', to.x, to.y, 10);
      await page.waitForFunction(() => (window as any).__store.ticket('TAB-101').ticket?.state.key === 'in_progress', null, { timeout: budget(10_000) });
    } finally {
      await page.context().close();
    }
  });

  it('at a 0.6 scale the ghost follows the pointer exactly and the card lands in the lane under it', async () => {
    const page = await openBoardPage();
    try {
      await mount(page, 720, 0.6);
      const from = await cardCentre(page, 'TAB-101');
      const to = await laneCentre(page, 'in_progress');
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move(from.x + 8, from.y + 8, { steps: 2 });
      await page.mouse.move(to.x, to.y, { steps: 8 });
      const ghost = await page.evaluate(() => {
        const g = document.querySelector('.trk-element .trk-board-ghost')!.getBoundingClientRect();
        return { x: g.left + g.width / 2, y: g.top + g.height / 2, width: g.width };
      });
      // the press was on the card's centre, so the ghost's centre sits under the pointer (within a pixel of rounding)
      expect(Math.abs(ghost.x - to.x)).toBeLessThan(2);
      expect(Math.abs(ghost.y - to.y)).toBeLessThan(2);
      // the card is 0.6 of its layout width on screen
      const layoutWidth = await page.evaluate(() => (document.querySelector('.trk-element .trk-board-card') as HTMLElement).offsetWidth);
      expect(Math.abs(ghost.width - layoutWidth * 0.6)).toBeLessThan(2);
      await page.mouse.up();
      await page.waitForFunction(() => (window as any).__store.ticket('TAB-101').ticket?.state.key === 'in_progress', null, { timeout: budget(10_000) });
    } finally {
      await page.context().close();
    }
  });
});

describe.skipIf(!available)('tracker element board drag on a zoomed board', { timeout: 200_000 }, () => {
  it('a drag on the live element at zoom 0.6 moves the card and does not pan the camera', async () => {
    const page = await browser!.newPage({ viewport: { width: 1280, height: 800 } });
    page.setDefaultTimeout(budget(45_000));
    try {
      await page.goto(`${base}?debug&trackerMock=board#/b/trk-${Math.random().toString(36).slice(2, 8)}`);
      await page.waitForFunction(() => (window as any).__board && (window as any).__trackerStore && [...(window as any).__board.store.cache.values()].some((o: any) => o.type === 'tracker'), null, { timeout: budget(30_000) });
      const id = await page.evaluate(() => [...(window as any).__board.store.cache.values()].find((o: any) => o.type === 'tracker').id as string);
      await page.evaluate((i) => { (window as any).__board.zoomTo(0.6); (window as any).__board.setSelection([i]); }, id);
      await page.locator('.trk-frame-wrap.is-work .trk-element-header').waitFor();
      await page.locator('.trk-frame-wrap.is-work .trk-element-switch button', { hasText: 'Board' }).click();
      await page.locator('.trk-frame-wrap.is-work .trk-board-lane[data-state="todo"] .trk-board-card').first().waitFor();
      const key = await page.locator('.trk-frame-wrap.is-work .trk-board-lane[data-state="todo"] .trk-board-card').first().getAttribute('data-key');
      const camBefore = await page.evaluate(() => ({ x: (window as any).__board.r.cam.x, y: (window as any).__board.r.cam.y, zoom: (window as any).__board.r.cam.zoom }));
      const from = await page.evaluate((k) => { const r = document.querySelector(`.trk-frame-wrap.is-work .trk-board-card[data-key="${k}"]`)!.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }, key);
      const to = await page.evaluate(() => { const r = document.querySelector('.trk-frame-wrap.is-work .trk-board-lane[data-state="in_progress"]')!.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 3 }; });
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move(from.x + 6, from.y + 6, { steps: 2 });
      await page.mouse.move(to.x, to.y, { steps: 10 });
      await page.mouse.up();
      await page.waitForFunction((k) => (window as any).__trackerStore.ticket(k).ticket?.state.key === 'in_progress', key, { timeout: budget(10_000) });
      await page.locator(`.trk-frame-wrap.is-work .trk-board-lane[data-state="in_progress"] .trk-board-card[data-key="${key}"]`).waitFor({ timeout: budget(10_000) });
      const camAfter = await page.evaluate(() => ({ x: (window as any).__board.r.cam.x, y: (window as any).__board.r.cam.y, zoom: (window as any).__board.r.cam.zoom }));
      expect(camAfter).toEqual(camBefore);
    } finally {
      await page.context().close();
    }
  });

  it('a press on a card selects the live element and focuses it, and the camera does not pan', async () => {
    const page = await browser!.newPage({ viewport: { width: 1280, height: 800 } });
    page.setDefaultTimeout(budget(45_000));
    try {
      await page.goto(`${base}?debug&trackerMock=board#/b/trk-${Math.random().toString(36).slice(2, 8)}`);
      await page.waitForFunction(() => (window as any).__board && (window as any).__trackerStore && [...(window as any).__board.store.cache.values()].some((o: any) => o.type === 'tracker'), null, { timeout: budget(30_000) });
      const id = await page.evaluate(() => [...(window as any).__board.store.cache.values()].find((o: any) => o.type === 'tracker').id as string);
      await page.evaluate((i) => (window as any).__board.setSelection([i]), id);
      await page.locator('.trk-frame-wrap.is-work .trk-element-header').waitFor();
      await page.locator('.trk-frame-wrap.is-work .trk-element-switch button', { hasText: 'Board' }).click();
      await page.locator('.trk-frame-wrap.is-work .trk-board-card').first().waitFor();
      await page.evaluate(() => (window as any).__board.setSelection([]));
      expect(await page.evaluate((i) => (window as any).__board.selection.includes(i), id)).toBe(false);
      const camBefore = await page.evaluate(() => ({ x: (window as any).__board.r.cam.x, y: (window as any).__board.r.cam.y }));
      const card = await page.locator('.trk-frame-wrap.is-work .trk-board-card').first().boundingBox();
      await page.mouse.click(card!.x + card!.width / 2, card!.y + card!.height / 2);
      expect(await page.evaluate((i) => (window as any).__board.selection.includes(i), id)).toBe(true);
      expect(await page.evaluate(() => ({ x: (window as any).__board.r.cam.x, y: (window as any).__board.r.cam.y }))).toEqual(camBefore);
    } finally {
      await page.close();
    }
  });

  it('switching read-only on and off while the Board tab shows changes the lanes at once: no +, no card menu, no drag, and back', async () => {
    const page = await browser!.newPage({ viewport: { width: 1280, height: 800 } });
    page.setDefaultTimeout(budget(45_000));
    try {
      await page.goto(`${base}?debug&trackerMock=board#/b/trk-${Math.random().toString(36).slice(2, 8)}`);
      await page.waitForFunction(() => (window as any).__board && (window as any).__trackerStore && [...(window as any).__board.store.cache.values()].some((o: any) => o.type === 'tracker'), null, { timeout: budget(30_000) });
      const id = await page.evaluate(() => [...(window as any).__board.store.cache.values()].find((o: any) => o.type === 'tracker').id as string);
      await page.evaluate((i) => (window as any).__board.setSelection([i]), id);
      await page.locator('.trk-frame-wrap.is-work .trk-element-header').waitFor();
      await page.locator('.trk-frame-wrap.is-work .trk-element-switch button', { hasText: 'Board' }).click();
      await page.locator('.trk-frame-wrap.is-work .trk-board-add').first().waitFor();
      await page.evaluate(() => (window as any).__board.store.setReadOnly(true));
      await page.waitForFunction(() => document.querySelectorAll('.trk-frame-wrap.is-work .trk-board-add').length === 0, null, { timeout: budget(10_000) });
      expect(await page.locator('.trk-frame-wrap.is-work .trk-board-menu-button').count()).toBe(0);
      expect(await page.locator('.trk-frame-wrap.is-work .trk-board-card.is-draggable').count()).toBe(0);
      await page.evaluate(() => (window as any).__board.store.setReadOnly(false));
      await page.waitForFunction(() => document.querySelectorAll('.trk-frame-wrap.is-work .trk-board-add').length > 0, null, { timeout: budget(10_000) });
      expect(await page.locator('.trk-frame-wrap.is-work .trk-board-card.is-draggable').count()).toBeGreaterThan(0);
      expect(await page.locator('.trk-frame-wrap.is-work .trk-board-menu-button').count()).toBeGreaterThan(0);
    } finally {
      await page.close();
    }
  });
});
