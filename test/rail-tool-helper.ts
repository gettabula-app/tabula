import type { Page } from 'playwright';
import { budget } from './wait-budget';

/**
 * Chooses one of the grouped rail tools (Text, Table, Markdown block, Link; Connector and Line) the way a person does: open the group's flyout from the keyboard,
 * then pick the menu item by its accessible name. Waits for the flyout to close; a tool choice also waits for it to become the group's tool.
 * Link is an action (it opens the Link popover), so only the flyout closing is awaited for it.
 */
export async function openRailTool(page: Page, name: 'Text' | 'Table' | 'Markdown block' | 'Link' | 'Connector' | 'Line'): Promise<void> {
  // the Text group (Text, Table, Markdown block, Link) and the Connectors and lines group (Connector, Line) are two rail buttons
  const group = page.locator(name === 'Connector' || name === 'Line' ? '.rail-connector-group' : '.rail-text-group');
  await group.waitFor({ state: 'visible', timeout: budget(10_000) });
  await group.focus();
  await page.keyboard.press('ArrowRight');
  await page.getByRole('menuitem', { name, exact: true }).click({ timeout: budget(10_000) });
  await page.locator('.rail-tool-pop').waitFor({ state: 'detached', timeout: budget(10_000) });
  if (name === 'Markdown block') await page.waitForFunction(() => (window as any).__board?.tool?.kind === 'markdown', null, { timeout: budget(10_000) });
  if (name === 'Table') await page.waitForFunction(() => (window as any).__board?.tool?.kind === 'table', null, { timeout: budget(10_000) });
  if (name === 'Text') await page.waitForFunction(() => (window as any).__board?.tool?.kind === 'text', null, { timeout: budget(10_000) });
  if (name === 'Connector') await page.waitForFunction(() => (window as any).__board?.tool?.kind === 'connector', null, { timeout: budget(10_000) });
  if (name === 'Line') await page.waitForFunction(() => (window as any).__board?.tool?.kind === 'line', null, { timeout: budget(10_000) });
}
