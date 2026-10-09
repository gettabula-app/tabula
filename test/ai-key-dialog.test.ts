import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api, type AiConfig } from '../src/api';
import { openAiKeyDialog } from '../src/ui/ai';
import { installFakeBrowser, textOf, type FakeBrowser, type FakeElement } from './fake-dom';

// QA sweep of the "Your AI key" dialog: the Test key status line says what happened, and a failed check reads as a failure
// (the `bad` class, which ai.css draws in the danger colour mixed with the text colour) where a good one does not.

let browser: FakeBrowser;
beforeEach(() => {
  browser = installFakeBrowser();
  vi.stubGlobal('requestAnimationFrame', () => 0);
});
afterEach(() => {
  browser.uninstall();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const config: AiConfig = {
  enabled: true, features: ['generate'], keySource: 'user', model: 'claude-sonnet-5-5', personalKeys: true, hasSecret: true,
  myKey: { provider: 'anthropic', hint: '4f2a', createdAt: 1, lastUsedAt: null },
};

const tick = () => new Promise((r) => setTimeout(r, 0));
const status = () => browser.document.body.querySelectorAll('.ai-problem')[0] as FakeElement;
const testButton = () => browser.document.body.querySelectorAll('button').find((b) => textOf(b) === 'Test key')!;

async function open() {
  vi.spyOn(api, 'aiConfig').mockResolvedValue(config);
  openAiKeyDialog();
  await tick();
}

describe('the Test key status line', () => {
  it('says the key works, in the plain colour', async () => {
    vi.spyOn(api, 'testMyAiKey').mockResolvedValue({ ok: true, provider: 'anthropic', checkedAt: 1 });
    await open();
    testButton().click();
    await tick();
    expect(textOf(status())).toBe('The key works.');
    expect(status().classList.contains('bad')).toBe(false);
  });

  it('says the key was rejected, in the danger colour, and goes back to plain on the next good check', async () => {
    const test = vi.spyOn(api, 'testMyAiKey').mockRejectedValueOnce(new ApiError(502, 'ai_key_invalid', 'rejected'));
    await open();
    testButton().click();
    await tick();
    expect(textOf(status())).toBe('The AI key was rejected.');
    expect(status().classList.contains('bad')).toBe(true);
    test.mockResolvedValueOnce({ ok: true, provider: 'anthropic', checkedAt: 2 });
    testButton().click();
    await tick();
    expect(textOf(status())).toBe('The key works.');
    expect(status().classList.contains('bad')).toBe(false);
  });
});
