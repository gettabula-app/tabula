import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { existsSync } from 'node:fs';
import { createServer, type ViteDevServer } from 'vite';
import { budget } from './wait-budget';

// Agents on a board in the real app (TAB-158, docs/agent-presence.md): what an agent drafted is marked until a person edits or accepts it, and an agent at work
// shows as a cursor and an avatar, named for the member it works for with its token name quoted after.

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
}, 300_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

async function open(): Promise<Page> {
  const page = await browser!.newPage({ viewport: { width: 1280, height: 800 } });
  page.setDefaultTimeout(budget(45_000));
  await page.goto(`${base}?debug#/b/ag-${Math.random().toString(36).slice(2, 8)}`);
  await page.waitForFunction(() => (window as any).__board, null, { timeout: budget(20_000) });
  return page;
}

const seedDraft = (page: Page) => page.evaluate(() => {
  const app = (window as any).__board;
  app.store.transactAs(() => {
    app.store.create({ id: 'd1', type: 'sticky', x: 100, y: 100, w: 192, h: 192, rotation: 0, z: app.store.topZ(), text: 'drafted', fill: '#FFE16B', proposedBy: { feature: 'agent', by: { id: 'u1', name: 'Ada' } } });
    app.store.create({ id: 'p1', type: 'sticky', x: 500, y: 100, w: 192, h: 192, rotation: 0, z: app.store.topZ(), text: 'by a person', fill: '#FFE16B' });
  }, 'seed');
  app.zoomToFit();
});
const marks = (page: Page) => page.evaluate(() => [...document.querySelectorAll('[data-agent-draft]')].map((el) => el.getAttribute('data-agent-draft')));
/** A state in the room's awareness as the relay would send it (the real field is written by the relay only). */
const setAgents = (page: Page, agents: unknown[] | null) => page.evaluate((list) => {
  const aw = (window as any).__board.conn.awareness;
  if (list) aw.states.set(987654, { agents: list }); else aw.states.delete(987654);
  aw.emit('change', [{ added: list ? [987654] : [], updated: [], removed: list ? [] : [987654] }, 'test']);
}, agents);

describe.skipIf(!available)('agent drafts', () => {
  it('marks what an agent made, until a person edits it or accepts it, and accepting is one undo step', async () => {
    const page = await open();
    await seedDraft(page);
    await page.waitForFunction(() => document.querySelectorAll('[data-agent-draft]').length === 1);
    expect(await marks(page)).toEqual(['d1']); // the sticky a person made has none
    // an edit by a person ends the draft
    await page.evaluate(() => (window as any).__board.store.update('d1', { text: 'edited by a person' }));
    await page.waitForFunction(() => document.querySelectorAll('[data-agent-draft]').length === 0);
    expect(await page.evaluate(() => (window as any).__board.store.get('d1').proposedBy)).toBeUndefined();
    // accept: back to a draft with undo, gone again with redo
    await page.evaluate(() => {
      const app = (window as any).__board;
      app.store.transactAs(() => app.store.update('d1', { proposedBy: { feature: 'agent', by: { id: 'u1', name: 'Ada' } } }), 'seed');
    });
    await page.waitForFunction(() => document.querySelectorAll('[data-agent-draft]').length === 1);
    await page.evaluate(() => { const app = (window as any).__board; app.setSelection(['d1']); app.acceptDrafts(); });
    await page.waitForFunction(() => document.querySelectorAll('[data-agent-draft]').length === 0);
    await page.evaluate(() => (window as any).__board.store.undo.undo());
    await page.waitForFunction(() => document.querySelectorAll('[data-agent-draft]').length === 1);
    await page.close();
  });

  it('says so in the properties panel, with an Accept button that ends the draft', async () => {
    const page = await open();
    await seedDraft(page);
    await page.evaluate(() => (window as any).__board.setSelection(['d1']));
    await page.getByRole('button', { name: 'More properties' }).click();
    await page.getByText('Drafted by an agent for Ada').waitFor();
    await page.getByRole('button', { name: 'Accept draft' }).click();
    await page.waitForFunction(() => document.querySelectorAll('[data-agent-draft]').length === 0);
    await page.close();
  });

  it('is not shown for a viewer-only or hostile value: a draft with another feature or no name is read as the clean value, text never as markup', async () => {
    const page = await open();
    await page.evaluate(() => {
      const app = (window as any).__board;
      app.store.transactAs(() => app.store.create({ id: 'd2', type: 'sticky', x: 100, y: 100, w: 192, h: 192, rotation: 0, z: app.store.topZ(), text: 'x', fill: '#FFE16B', proposedBy: { feature: 'agent', by: { id: 'u1', name: '<img src=x onerror=window.pwned=1>' } } }), 'seed');
      app.zoomToFit();
      app.setSelection(['d2']);
    });
    await page.getByRole('button', { name: 'More properties' }).click();
    await page.getByText(/Drafted by an agent for/).waitFor();
    expect(await page.evaluate(() => [(window as any).pwned ?? null, document.querySelectorAll('.props-origin img').length])).toEqual([null, 0]);
    await page.close();
  });
});

describe.skipIf(!available)('agents at work', () => {
  it('shows an agent as a cursor named for the member it works for with its token quoted, and as an avatar that goes there; both go when the agent does', async () => {
    const page = await open();
    await seedDraft(page);
    await setAgents(page, [{ id: 'abcdef012345', token: 'Claude', member: 'Ada', x: 150, y: 150 }]);
    await page.waitForSelector('.remote-cursor-agent');
    expect(await page.locator('.remote-cursor-agent .remote-cursor-name').textContent()).toBe("Ada's agent");
    expect(await page.locator('.remote-cursor-agent .remote-cursor-token').textContent()).toBe('“Claude”');
    const avatar = page.locator('.agent-avatar');
    await avatar.waitFor();
    expect(await avatar.getAttribute('aria-label')).toContain("Ada's agent “Claude” is working on this board");
    await setAgents(page, null);
    await page.waitForFunction(() => document.querySelectorAll('.remote-cursor-agent, .agent-avatar').length === 0);
    await page.close();
  });

  it('reads the field as untrusted: a token name is cleaned and cut, a bad id or position is not used, nothing becomes markup', async () => {
    const page = await open();
    await setAgents(page, [
      { id: 'abcdef012345', token: `Cl‮au​de${'x'.repeat(100)}<b>`, member: '  Ada  ', x: 10, y: 10 },
      { id: 'not-an-id', token: 'Imposter', member: 'Eve', x: 1, y: 1 },
      { id: 'fedcba543210', token: 'NoPlace', member: null, x: 'far', y: null },
    ]);
    await page.waitForSelector('.remote-cursor-agent');
    const seen = await page.evaluate(() => ({
      tokens: [...document.querySelectorAll('.remote-cursor-token')].map((e) => e.textContent),
      names: [...document.querySelectorAll('.remote-cursor-agent .remote-cursor-name')].map((e) => e.textContent),
      avatars: document.querySelectorAll('.agent-avatar').length,
      markup: document.querySelectorAll('.remote-cursor-token b').length,
    }));
    expect(seen.tokens).toHaveLength(1); // the one without a position has an avatar but no cursor, the one with a bad id is ignored
    expect(seen.tokens[0]!.length).toBeLessThanOrEqual(42);
    expect(seen.tokens[0]).toContain('Claude'.slice(0, 2));
    expect(seen.names).toEqual(["Ada's agent"]);
    expect(seen.avatars).toBe(2);
    expect(seen.markup).toBe(0);
    await page.close();
  });
});
