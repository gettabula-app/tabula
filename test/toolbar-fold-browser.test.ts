import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { existsSync } from 'node:fs';
import { createServer, type ViteDevServer } from 'vite';

// TAB-403, the left tool rail folds into a 22 x 64 tab on the window's left edge, centred on the rail (src/ui/rail-collapse.ts). The
// toggle is the rail's first row, "Hide toolbar"; the tab is the same control while folded. In a real browser on a blank board: the
// toggle folds the rail, the tab opens it again, the motion moves only the rail's transform and clip-path (and the chevron's and the
// tab's opacity), reduced motion is an opacity crossfade, the tab's touch area is 44 px, the board does not move, and the saved state
// survives a reload.

let server: ViteDevServer | undefined;
let browser: Browser | undefined;
let base = '';
const available = existsSync(chromium.executablePath());

beforeAll(async () => {
  if (!available) return;
  server = await createServer({ configFile: false, root: process.cwd(), logLevel: 'error', server: { host: '127.0.0.1', port: 0 } });
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === 'string') throw new Error('Vite did not open a TCP port');
  base = `http://127.0.0.1:${address.port}/`;
  browser = await chromium.launch({ headless: true });
});

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

async function openBoard(options: { width?: number; height?: number; touch?: boolean; reducedMotion?: boolean } = {}): Promise<{ context: BrowserContext; page: Page }> {
  const { width = 1280, height = 800, touch = false, reducedMotion = false } = options;
  for (let attempt = 0; ; attempt++) {
    const context = await browser!.newContext({
      viewport: { width, height }, hasTouch: touch, isMobile: touch, reducedMotion: reducedMotion ? 'reduce' : 'no-preference',
    });
    const page = await context.newPage();
    try {
      // ?debug exposes window.__board (src/main.ts), which the read-only check needs
      await page.goto(`${base}?debug`);
      await page.getByRole('button', { name: 'New board' }).click({ timeout: attempt >= 2 ? 90_000 : 25_000 });
      await page.getByRole('menuitem', { name: 'Blank board' }).click({ timeout: attempt >= 2 ? 90_000 : 25_000 });
      await page.getByRole('button', { name: 'Menu' }).waitFor({ timeout: 25_000 });
      await page.locator('.chrome > .rail > .rail-toggle').waitFor({ timeout: 25_000 });
      return { context, page };
    } catch (error) {
      await context.close();
      if (attempt >= 2) throw error;
    }
  }
}

/** The fold as a person sees it: boxes relative to the chrome, the rail's visibility and inert state, the tab and the toggle, and the focus. */
function readFold() {
  const chrome = document.querySelector<HTMLElement>('.chrome')!;
  const rail = chrome.querySelector<HTMLElement>(':scope > .rail')!;
  const pill = chrome.querySelector<HTMLElement>(':scope > .rail-pill')!;
  const toggle = rail.querySelector<HTMLButtonElement>(':scope > .rail-toggle')!;
  const origin = chrome.getBoundingClientRect();
  const box = (el: Element) => {
    const r = el.getBoundingClientRect();
    return { left: r.left - origin.left, top: r.top - origin.top, width: r.width, height: r.height };
  };
  const active = document.activeElement;
  const railStyle = getComputedStyle(rail);
  return {
    phase: chrome.dataset.railPhase ?? null,
    rail: { box: box(rail), visibility: railStyle.visibility, pointerEvents: railStyle.pointerEvents, inert: rail.inert, transform: railStyle.transform },
    pill: { box: box(pill), display: getComputedStyle(pill).display, label: pill.getAttribute('aria-label'), expanded: pill.getAttribute('aria-expanded'), tip: pill.dataset.tip },
    toggle: {
      expanded: toggle.getAttribute('aria-expanded'), label: toggle.getAttribute('aria-label'), tip: toggle.dataset.tip,
      disabled: toggle.disabled, inRail: rail.contains(toggle), firstChild: rail.firstElementChild === toggle,
      box: box(toggle), display: getComputedStyle(toggle).display,
    },
    focus: active === pill ? 'pill' : active === toggle ? 'toggle' : active?.tagName ?? null,
  };
}

/** How far the tab's centre is from the rail's centre, in px. The tab is centred on the rail, so this is 0 when it is aligned. */
const centreGap = (fold: ReturnType<typeof readFold>) => Math.abs(fold.pill.box.top + fold.pill.box.height / 2 - (fold.rail.box.top + fold.rail.box.height / 2));

/** The number of animations (and transitions) still running on the rail, its children or the tab. */
function foldAnimationCount(): number {
  const chrome = document.querySelector<HTMLElement>('.chrome')!;
  const rail = chrome.querySelector<HTMLElement>(':scope > .rail')!;
  const pill = chrome.querySelector<HTMLElement>(':scope > .rail-pill')!;
  return chrome.getAnimations({ subtree: true }).filter((a) => {
    const target = (a.effect as KeyframeEffect | null)?.target as Element | null;
    return !!target && (rail.contains(target) || pill.contains(target));
  }).length;
}

/** True once the phase is the resting one and no animation of the fold (the rail, the tab or the tools) is still running. */
function foldSettled(phase: string): boolean {
  const chrome = document.querySelector<HTMLElement>('.chrome');
  if (!chrome || chrome.dataset.railPhase !== phase) return false;
  const rail = chrome.querySelector<HTMLElement>(':scope > .rail')!;
  const pill = chrome.querySelector<HTMLElement>(':scope > .rail-pill')!;
  const running = chrome.getAnimations({ subtree: true }).filter((a) => {
    const target = (a.effect as KeyframeEffect | null)?.target as Element | null;
    return !!target && (rail.contains(target) || pill.contains(target));
  });
  return running.length === 0;
}

async function settle(page: Page, phase: 'collapsed' | 'expanded') {
  await expect.poll(() => page.evaluate(foldSettled, phase), { timeout: 5_000 }).toBe(true);
}

/** Clicks the control that moves the fold, then returns the animations it started, read in the same task so they are the ones the click made. */
function startFold() {
  const chrome = document.querySelector<HTMLElement>('.chrome')!;
  const rail = chrome.querySelector<HTMLElement>(':scope > .rail')!;
  const pill = chrome.querySelector<HTMLElement>(':scope > .rail-pill')!;
  // a folded rail opens from the tab, an open one folds from the toggle
  if (chrome.dataset.railPhase === 'collapsed') pill.click();
  else rail.querySelector<HTMLButtonElement>(':scope > .rail-toggle')!.click();
  const summary = (a: Animation) => {
    const effect = a.effect as KeyframeEffect;
    const timing = effect.getTiming();
    // the CSS easing is set per keyframe; the effect's own timing reads linear
    const keyframes = effect.getKeyframes();
    const properties = new Set(keyframes.flatMap((k) => Object.keys(k)).filter((p) => !['offset', 'easing', 'composite', 'computedOffset'].includes(p)));
    return {
      name: (a as CSSAnimation).animationName ?? '',
      target: effect.target === rail ? 'rail' : effect.target === pill ? 'pill' : 'other',
      duration: Number(timing.duration),
      easing: String(keyframes[0]?.easing ?? timing.easing),
      fill: String(timing.fill),
      properties: [...properties].sort(),
    };
  };
  return chrome.getAnimations({ subtree: true }).filter((a) => {
    const target = (a.effect as KeyframeEffect | null)?.target as Element | null;
    return !!target && (rail.contains(target) || pill.contains(target));
  }).map((a) => summary(a as Animation));
}

describe.skipIf(!available)('the left tool rail folds into a tab (TAB-403)', { timeout: 200_000 }, () => {
  it('starts expanded: the toggle is the rail\'s first row, 28 px high, and the tab is hidden', async () => {
    const { context, page } = await openBoard();
    const fold = await page.evaluate(readFold);
    expect(fold.phase).toBe('expanded');
    expect(fold.toggle).toMatchObject({ expanded: 'true', label: 'Hide toolbar', tip: 'Hide toolbar', inRail: true, firstChild: true, disabled: false, display: 'grid' });
    expect(fold.toggle.box.height).toBeCloseTo(28, 0);
    expect(fold.pill.display).toBe('none');
    expect(fold.rail).toMatchObject({ visibility: 'visible', inert: false });
    // the app's own tooltip engine reads data-tip
    await page.locator('.chrome > .rail > .rail-toggle').hover();
    await expect.poll(() => page.evaluate(() => [...document.querySelectorAll('.tip.show')].map((t) => t.textContent ?? '').join('|'))).toContain('Hide toolbar');
    await context.close();
  });

  it('folds to a 22 x 64 tab on the window\'s left edge, centred on the rail, and makes the rail inert', async () => {
    const { context, page } = await openBoard();
    const before = await page.evaluate(readFold);
    await page.locator('.chrome > .rail > .rail-toggle').click();
    await settle(page, 'collapsed');
    const fold = await page.evaluate(readFold);
    expect(fold.rail).toMatchObject({ visibility: 'hidden', pointerEvents: 'none', inert: true });
    // the rail stays where it was; only its clip and the tab change
    expect(fold.rail.box.left).toBeCloseTo(before.rail.box.left, 0);
    expect(fold.rail.box.top).toBeCloseTo(before.rail.box.top, 0);
    expect(fold.pill.display).toBe('flex');
    expect(fold.pill.box.left).toBeCloseTo(0, 0);
    expect(fold.pill.box.width).toBeCloseTo(22, 0);
    expect(fold.pill.box.height).toBeCloseTo(64, 0);
    expect(centreGap(fold)).toBeLessThanOrEqual(1);
    // flush with the window's edge itself, not only with the chrome
    expect(await page.evaluate(() => document.querySelector<HTMLElement>('.chrome > .rail-pill')!.getBoundingClientRect().left)).toBeCloseTo(0, 0);
    expect(fold.pill).toMatchObject({ label: 'Show toolbar', expanded: 'false', tip: 'Show toolbar' });
    expect(fold.toggle.expanded).toBe('false');
    expect(fold.focus).toBe('pill');
    // a point where the rail's tools were is not on the rail any more
    const onRail = await page.evaluate(() => {
      const rail = document.querySelector<HTMLElement>('.chrome > .rail')!;
      const r = rail.getBoundingClientRect();
      return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest('.rail') != null;
    });
    expect(onRail).toBe(false);
    await context.close();
  });

  it('draws the tab flat on the window\'s edge with rounded right corners, and two concave joins that meet its top and bottom edges', async () => {
    const { context, page } = await openBoard();
    await page.locator('.chrome > .rail > .rail-toggle').click();
    await settle(page, 'collapsed');
    const shape = await page.evaluate(() => {
      const pill = document.querySelector<HTMLElement>('.chrome > .rail-pill')!;
      const style = getComputedStyle(pill);
      const box = pill.getBoundingClientRect();
      const joins = [...pill.querySelectorAll<HTMLElement>(':scope > .rail-pill-join')].map((j) => {
        const r = j.getBoundingClientRect();
        const s = getComputedStyle(j);
        return {
          top: r.top, bottom: r.bottom, left: r.left, width: r.width, height: r.height,
          pointerEvents: s.pointerEvents, ariaHidden: j.getAttribute('aria-hidden'), background: s.backgroundImage,
          isTop: j.classList.contains('top'), isBottom: j.classList.contains('bottom'),
        };
      });
      return {
        box: { top: box.top, bottom: box.bottom, left: box.left },
        corners: {
          topLeft: style.borderTopLeftRadius, bottomLeft: style.borderBottomLeftRadius,
          topRight: style.borderTopRightRadius, bottomRight: style.borderBottomRightRadius,
        },
        overflow: [style.overflowX, style.overflowY],
        joins,
        // a mouse hit area 2 px wider than the tab on each side (inset 0 -2px)
        mouseHitWidth: getComputedStyle(pill, '::before').width,
      };
    });
    expect(shape.joins).toHaveLength(2);
    const top = shape.joins.find((j) => j.isTop)!;
    const bottom = shape.joins.find((j) => j.isBottom)!;
    expect(top).toBeDefined();
    expect(bottom).toBeDefined();
    for (const join of [top, bottom]) {
      expect(join.width).toBeCloseTo(8, 0);
      expect(join.height).toBeCloseTo(8, 0);
      expect(join.left).toBeCloseTo(shape.box.left, 0);
      expect(join.pointerEvents).toBe('none');
      expect(join.ariaHidden).toBe('true');
      expect(join.background).toContain('radial-gradient');
    }
    // the top join sits directly above the tab's top edge, the bottom join directly below its bottom edge
    expect(Math.abs(top.bottom - shape.box.top)).toBeLessThanOrEqual(1);
    expect(Math.abs(bottom.top - shape.box.bottom)).toBeLessThanOrEqual(1);
    // square on the window's edge, rounded on the free side
    expect(shape.corners.topLeft).toBe('0px');
    expect(shape.corners.bottomLeft).toBe('0px');
    expect(Number.parseFloat(shape.corners.topRight)).toBeGreaterThan(0);
    expect(Number.parseFloat(shape.corners.bottomRight)).toBeGreaterThan(0);
    // nothing clips the joins
    expect(shape.overflow).toEqual(['visible', 'visible']);
    expect(shape.mouseHitWidth).toBe('26px');
    await context.close();
  });

  it('paints the joins in the tab\'s surface colour, and changes them with the tab on hover', async () => {
    const { context, page } = await openBoard();
    await page.locator('.chrome > .rail > .rail-toggle').click();
    await settle(page, 'collapsed');
    const colours = () => page.evaluate(() => {
      const pill = document.querySelector<HTMLElement>('.chrome > .rail-pill')!;
      return {
        pill: getComputedStyle(pill).backgroundColor,
        top: getComputedStyle(pill.querySelector<HTMLElement>(':scope > .rail-pill-join.top')!).backgroundImage,
        bottom: getComputedStyle(pill.querySelector<HTMLElement>(':scope > .rail-pill-join.bottom')!).backgroundImage,
      };
    });
    const rest = await colours();
    expect(rest.top).toContain(rest.pill);
    expect(rest.bottom).toContain(rest.pill);
    await page.locator('.chrome > .rail-pill').hover();
    await expect.poll(async () => (await colours()).pill).not.toBe(rest.pill);
    const hovered = await colours();
    expect(hovered.top).toContain(hovered.pill);
    expect(hovered.bottom).toContain(hovered.pill);
    await context.close();
  });

  it('toggles with Enter both ways: the toggle folds the rail with focus on the tab, and the tab opens it with focus back on the toggle', async () => {
    const { context, page } = await openBoard();
    const original = await page.evaluate(readFold);
    await page.locator('.chrome > .rail > .rail-toggle').focus();
    await page.keyboard.press('Enter');
    await settle(page, 'collapsed');
    expect((await page.evaluate(readFold)).focus).toBe('pill');
    await page.keyboard.press('Enter');
    await settle(page, 'expanded');
    const fold = await page.evaluate(readFold);
    expect(fold.focus).toBe('toggle');
    expect(fold.rail).toMatchObject({ visibility: 'visible', inert: false });
    expect(fold.toggle.expanded).toBe('true');
    expect(fold.pill.display).toBe('none');
    expect(fold.rail.box.left).toBeCloseTo(original.rail.box.left, 0);
    expect(fold.rail.box.top).toBeCloseTo(original.rail.box.top, 0);
    expect(fold.rail.box.width).toBeCloseTo(original.rail.box.width, 0);
    await context.close();
  });

  it('keeps the tools working by shortcut while folded, and hides the tray that belongs to a rail tool', async () => {
    const { context, page } = await openBoard();
    await page.locator('.chrome > .rail > .rail-toggle').click();
    await settle(page, 'collapsed');
    await page.keyboard.press('p');
    await expect.poll(() => page.locator('.board-surface').getAttribute('data-tool')).toBe('pen');
    await page.keyboard.press('f');
    await expect.poll(() => page.locator('.board-surface').getAttribute('data-tool')).toBe('frame');
    await page.keyboard.press('v');
    await expect.poll(() => page.locator('.board-surface').getAttribute('data-tool')).toBe('select');
    await page.keyboard.press('n');
    await expect.poll(() => page.locator('.board-surface').getAttribute('data-tool')).toBe('sticky');
    await page.keyboard.press('p');
    await expect.poll(() => page.locator('.board-surface').getAttribute('data-tool')).toBe('pen');
    const penHidden = () => page.evaluate(() => getComputedStyle(document.querySelector<HTMLElement>('.chrome > .pen-tray')!).visibility);
    expect(await penHidden()).toBe('hidden');
    expect((await page.evaluate(readFold)).phase).toBe('collapsed');
    await page.locator('.chrome > .rail-pill').click();
    await settle(page, 'expanded');
    expect(await penHidden()).toBe('visible');
    await context.close();
  });

  it('closes an open tool flyout when the rail folds, and leaves focus on the tab', async () => {
    const { context, page } = await openBoard();
    await page.locator('.rail-text-group').focus();
    await page.keyboard.press('ArrowRight');
    await expect.poll(() => page.locator('.rail-tool-pop').count()).toBe(1);
    // a programmatic click, so the popover's own outside-pointer close cannot be what closes it
    await page.evaluate(() => document.querySelector<HTMLButtonElement>('.chrome > .rail > .rail-toggle')!.click());
    await settle(page, 'collapsed');
    expect(await page.locator('.rail-tool-pop').count()).toBe(0);
    expect((await page.evaluate(readFold)).focus).toBe('pill');
    await context.close();
  });

  it('keeps the tab centred on the rail after the window is resized', async () => {
    const { context, page } = await openBoard();
    await page.locator('.chrome > .rail > .rail-toggle').click();
    await settle(page, 'collapsed');
    const aligned = async () => {
      const fold = await page.evaluate(readFold);
      return centreGap(fold) <= 1 && Math.abs(fold.pill.box.left) <= 1;
    };
    expect(await aligned()).toBe(true);
    await page.setViewportSize({ width: 1000, height: 700 });
    await expect.poll(aligned, { timeout: 5_000 }).toBe(true);
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect.poll(aligned, { timeout: 5_000 }).toBe(true);
    await context.close();
  });

  it('keeps the tab centred on the rail when the board moves the rail by --panel-top, without a resize', async () => {
    // 800 px is inside the 860 px breakpoint, where styles.css ties the rail's top to --panel-top; 1000 px tall leaves the rail's content
    // fitting below its max-height, so moving the top changes only its position: no resize and no ResizeObserver callback.
    const { context, page } = await openBoard({ width: 800, height: 1000 });
    await page.locator('.chrome > .rail > .rail-toggle').click();
    await settle(page, 'collapsed');
    // not capped at max-height: the content fits, so nothing overflows the rail's clip
    const fits = () => {
      const rail = document.querySelector<HTMLElement>('.chrome > .rail')!;
      return rail.scrollHeight <= rail.clientHeight;
    };
    expect(await page.evaluate(fits)).toBe(true);
    const before = await page.evaluate(readFold);
    await page.evaluate(() => document.querySelector<HTMLElement>('.chrome')!.style.setProperty('--panel-top', '160px'));
    await expect.poll(async () => Math.abs((await page.evaluate(readFold)).rail.box.top - before.rail.box.top), { timeout: 5_000 }).toBeGreaterThanOrEqual(20);
    // the rail moved and did not change size, the case the fix is for
    const moved = await page.evaluate(readFold);
    expect(Math.abs(moved.rail.box.height - before.rail.box.height)).toBeLessThanOrEqual(1);
    await expect.poll(async () => centreGap(await page.evaluate(readFold)), { timeout: 5_000 }).toBeLessThanOrEqual(1);
    await context.close();
  });

  it('keeps the tab centred on the rail when the window is resized during the collapse motion', async () => {
    // 760 px to 700 px is a 60 px change that crosses the 720 px breakpoint (styles.css), which moves the rail's top from 72 px to 64 px
    const { context, page } = await openBoard({ height: 760 });
    const before = await page.evaluate(readFold);
    // an in-page click, so the resize below lands while the 240 ms collapse is still running
    await page.evaluate(() => document.querySelector<HTMLButtonElement>('.chrome > .rail > .rail-toggle')!.click());
    await page.setViewportSize({ width: 1280, height: 700 });
    expect(await page.evaluate(() => document.querySelector<HTMLElement>('.chrome')!.dataset.railPhase)).toBe('collapsing');
    await settle(page, 'collapsed');
    const fold = await page.evaluate(readFold);
    // the rail really moved, so the check below is not passing on a rail that stayed put
    expect(Math.abs(fold.rail.box.top - before.rail.box.top)).toBeGreaterThanOrEqual(4);
    expect(centreGap(fold)).toBeLessThanOrEqual(1);
    await context.close();
  });

  it('keeps the tab centred on the rail after a phone turns, and after a reload', async () => {
    const { context, page } = await openBoard({ width: 390, height: 844, touch: true });
    await page.locator('.chrome > .rail > .rail-toggle').tap();
    await settle(page, 'collapsed');
    const centred = async () => centreGap(await page.evaluate(readFold));
    expect(await centred()).toBeLessThanOrEqual(1);
    await page.setViewportSize({ width: 844, height: 390 });
    await expect.poll(centred, { timeout: 5_000 }).toBeLessThanOrEqual(1);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect.poll(centred, { timeout: 5_000 }).toBeLessThanOrEqual(1);
    await page.reload();
    await page.locator('.chrome > .rail-pill').waitFor({ state: 'visible', timeout: 25_000 });
    await expect.poll(centred, { timeout: 5_000 }).toBeLessThanOrEqual(1);
    expect((await page.evaluate(readFold)).pill.box.left).toBeCloseTo(0, 0);
    await context.close();
  });

  it('does not move or resize the board when the rail folds', async () => {
    const { context, page } = await openBoard();
    const board = page.locator('.board-surface');
    const before = await board.boundingBox();
    await page.locator('.chrome > .rail > .rail-toggle').click();
    await settle(page, 'collapsed');
    const after = await board.boundingBox();
    expect(after).toEqual(before);
    await context.close();
  });

  it('moves only clip-path, transform and opacity, fills backwards, and leaves no transform once it settles', async () => {
    const { context, page } = await openBoard();
    const collapsing = await page.evaluate(startFold);
    const collapse = collapsing.find((a) => a.name === 'rc-rail-collapse');
    expect(collapse).toMatchObject({ target: 'rail', duration: 240, fill: 'backwards' });
    expect(collapse!.easing).toMatch(/cubic-bezier\(0\.77, 0, 0\.175, 1\)/);
    expect(collapse!.properties).toEqual(['clipPath', 'transform']);
    for (const a of collapsing) {
      expect(a.fill).not.toMatch(/both|forwards/);
      for (const property of a.properties) expect(['clipPath', 'opacity', 'transform']).toContain(property);
    }
    await settle(page, 'collapsed');
    expect((await page.evaluate(readFold)).rail.transform).toBe('none');

    const expanding = await page.evaluate(startFold);
    const reopen = expanding.find((a) => a.name === 'rc-rail-expand');
    expect(reopen).toMatchObject({ target: 'rail', duration: 200, fill: 'backwards' });
    expect(reopen!.easing).toMatch(/cubic-bezier\(0\.23, 1, 0\.32, 1\)/);
    expect(reopen!.properties).toEqual(['clipPath', 'transform']);
    for (const a of expanding) {
      expect(a.fill).not.toMatch(/both|forwards/);
      for (const property of a.properties) expect(['clipPath', 'opacity', 'transform']).toContain(property);
    }
    await settle(page, 'expanded');
    expect((await page.evaluate(readFold)).rail.transform).toBe('none');
    await context.close();
  });

  it('uses a 120 ms opacity crossfade and no clip or slide under reduced motion', async () => {
    const { context, page } = await openBoard({ reducedMotion: true });
    const started = await page.evaluate(startFold);
    const railAnimations = started.filter((a) => a.target === 'rail');
    expect(railAnimations.map((a) => a.name)).toEqual(['rc-rail-fade-out']);
    expect(railAnimations[0]).toMatchObject({ duration: 120, fill: 'backwards' });
    expect(railAnimations[0].properties).toEqual(['opacity']);
    expect(started.some((a) => a.name === 'rc-pill-in' && a.duration === 120)).toBe(true);
    expect(started.some((a) => a.properties.includes('clipPath') || a.properties.includes('transform'))).toBe(false);
    expect(started.some((a) => a.name.includes('chev'))).toBe(false);
    await settle(page, 'collapsed');
    await context.close();
  });

  it('gives the tab a 44 px hit area to a finger, with the visible tab still 22 x 64', async () => {
    const { context, page } = await openBoard({ width: 390, height: 844, touch: true });
    expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
    await page.locator('.chrome > .rail > .rail-toggle').tap();
    await settle(page, 'collapsed');
    const touch = await page.evaluate(() => {
      const pill = document.querySelector<HTMLElement>('.chrome > .rail-pill')!;
      const r = pill.getBoundingClientRect();
      const y = r.top + r.height / 2;
      const before = getComputedStyle(pill, '::before');
      return {
        visibleWidth: r.width,
        visibleHeight: r.height,
        hitWidth: Number.parseFloat(before.width),
        hitHeight: Number.parseFloat(before.height),
        reachesAt40: document.elementFromPoint(r.left + 40, y) === pill,
        reachesAt50: document.elementFromPoint(r.left + 50, y) === pill,
      };
    });
    expect(touch.visibleWidth).toBeCloseTo(22, 0);
    expect(touch.visibleHeight).toBeCloseTo(64, 0);
    expect(touch.hitWidth).toBe(44);
    expect(touch.hitHeight).toBe(64);
    expect(touch.reachesAt40).toBe(true);
    expect(touch.reachesAt50).toBe(false);
    await context.close();
  });

  it('gives the toggle row a 44 px height to a finger', async () => {
    const { context, page } = await openBoard({ width: 390, height: 844, touch: true });
    const toggle = await page.evaluate(() => document.querySelector<HTMLElement>('.chrome > .rail > .rail-toggle')!.getBoundingClientRect().height);
    expect(toggle).toBeCloseTo(44, 0);
    await context.close();
  });

  it('on a 390 px phone the rail is still a left column, and it folds to the same 22 x 64 tab, centred on it', async () => {
    const { context, page } = await openBoard({ width: 390, height: 844, touch: true });
    const before = await page.evaluate(readFold);
    expect(before.rail.box.left).toBeLessThanOrEqual(16);
    expect(before.rail.box.height).toBeGreaterThan(before.rail.box.width);
    await page.locator('.chrome > .rail > .rail-toggle').tap();
    await settle(page, 'collapsed');
    const fold = await page.evaluate(readFold);
    expect(fold.pill.box.width).toBeCloseTo(22, 0);
    expect(fold.pill.box.height).toBeCloseTo(64, 0);
    expect(fold.pill.box.left).toBeCloseTo(0, 0);
    expect(centreGap(fold)).toBeLessThanOrEqual(1);
    await context.close();
  });

  it('keeps the folded state across a reload, and the expanded state once it is opened again', async () => {
    const { context, page } = await openBoard();
    await page.locator('.chrome > .rail > .rail-toggle').click();
    await settle(page, 'collapsed');
    expect(await page.evaluate(() => localStorage.getItem('tabula.toolbar.collapsed'))).toBe('1');
    await page.reload();
    await page.locator('.chrome > .rail-pill').waitFor({ state: 'visible', timeout: 25_000 });
    expect(await page.evaluate(foldAnimationCount)).toBe(0);
    expect((await page.evaluate(readFold)).phase).toBe('collapsed');
    await page.locator('.chrome > .rail-pill').click();
    await settle(page, 'expanded');
    expect(await page.evaluate(() => localStorage.getItem('tabula.toolbar.collapsed'))).toBe(null);
    await page.reload();
    await page.locator('.chrome > .rail > .rail-toggle').waitFor({ timeout: 25_000 });
    expect((await page.evaluate(readFold)).phase).toBe('expanded');
    await context.close();
  });

  it('lets the toggle fold and open the rail on a read-only board', async () => {
    const { context, page } = await openBoard();
    await page.evaluate(() => { (window as unknown as { __board: { store: { setReadOnly(on: boolean): void } } }).__board.store.setReadOnly(true); });
    await expect.poll(() => page.evaluate(() => document.querySelector<HTMLButtonElement>('.chrome > .rail > .rail-toggle')!.disabled)).toBe(false);
    await page.locator('.chrome > .rail > .rail-toggle').click();
    await settle(page, 'collapsed');
    await page.locator('.chrome > .rail-pill').click();
    await settle(page, 'expanded');
    await context.close();
  });

  it('keeps the tab\'s focus ring inside the window: the ring is drawn 2 px inside, and the tab is flush with the edge', async () => {
    const { context, page } = await openBoard();
    // the keyboard starts the fold, so the tab that takes focus shows its focus ring
    await page.locator('.chrome > .rail > .rail-toggle').focus();
    await page.keyboard.press('Enter');
    await settle(page, 'collapsed');
    const ring = await page.evaluate(() => {
      const pill = document.querySelector<HTMLElement>('.chrome > .rail-pill')!;
      const r = pill.getBoundingClientRect();
      return {
        focused: document.activeElement === pill,
        focusVisible: pill.matches(':focus-visible'),
        outlineOffset: getComputedStyle(pill).outlineOffset,
        left: r.left,
        top: r.top,
      };
    });
    expect(ring.focused).toBe(true);
    expect(ring.focusVisible).toBe(true);
    expect(ring.outlineOffset).toBe('-2px');
    expect(ring.left).toBeCloseTo(0, 0);
    expect(ring.top).toBeGreaterThanOrEqual(0);
    await context.close();
  });
});
