import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api, type AiConfig } from '../src/api';
import { openAiKeyDialog } from '../src/ui/ai';
import { FakeEvent, installFakeBrowser, textOf, type as typeInto, type FakeBrowser, type FakeElement } from './fake-dom';

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
  enabled: true, features: ['generate'], keySource: 'user', provider: 'anthropic', model: 'claude-sonnet-5-5', personalKeys: true, hasSecret: true,
  myKey: { provider: 'anthropic', hint: '4f2a', baseUrl: null, model: null, createdAt: 1, lastUsedAt: null },
};
const emptyConfig: AiConfig = { ...config, myKey: null };

const tick = () => new Promise((r) => setTimeout(r, 0));
const status = () => browser.document.body.querySelectorAll('.ai-problem')[0] as FakeElement;
const testButton = () => browser.document.body.querySelectorAll('button').find((b) => textOf(b) === 'Test key')!;

async function open(current: AiConfig = config) {
  vi.spyOn(api, 'aiConfig').mockResolvedValue(current);
  openAiKeyDialog();
  await tick();
}

const providerSelect = () => browser.document.body.querySelector('select[aria-label="Provider"]') as FakeElement;
const input = (label: string) => browser.document.body.querySelectorAll('input').find((field) => field.getAttribute('aria-label') === label)!;
const saveButton = () => browser.document.body.querySelectorAll('button').find((b) => textOf(b) === 'Save key')!;
const chooseProvider = (value: string) => {
  providerSelect().value = value;
  providerSelect().dispatchEvent(new FakeEvent('change'));
};
const fill = (field: FakeElement, value: string) => typeInto(field, value);
const formProblem = () => browser.document.body.querySelectorAll('.ai-problem').find((el) => el.getAttribute('role') === 'status')!;

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

  it('tests a saved compatible-provider key through the same button', async () => {
    vi.spyOn(api, 'testMyAiKey').mockResolvedValue({ ok: true, provider: 'openai-compatible', checkedAt: 1 });
    await open({ ...config, provider: 'openai-compatible', myKey: { ...config.myKey!, provider: 'openai-compatible', baseUrl: 'https://api.example/v1', model: 'moonshotai/kimi-k3' } });
    testButton().click();
    await tick();
    expect(textOf(status())).toBe('The key works.');
  });
});

describe('compatible-provider key settings', () => {
  it('shows the endpoint and model fields only after choosing the compatible provider', async () => {
    await open(emptyConfig);
    expect(providerSelect().value).toBe('anthropic');
    expect(browser.document.body.querySelector('input[placeholder="https://integrate.api.nvidia.com/v1"]')).toBeNull();
    expect(browser.document.body.querySelector('input[placeholder="moonshotai/kimi-k3"]')).toBeNull();
    chooseProvider('openai-compatible');
    expect(browser.document.body.querySelector('input[placeholder="https://integrate.api.nvidia.com/v1"]')).not.toBeNull();
    expect(browser.document.body.querySelector('input[placeholder="moonshotai/kimi-k3"]')).not.toBeNull();
    expect(textOf(browser.document.body)).toContain("Where your provider's API lives");
    expect(textOf(browser.document.body)).toContain('The model id your provider calls it');
  });

  it.each([
    ['http://api.example/v1', 'moonshotai/kimi-k3', 'Base URL must be an HTTPS address.'],
    ['https://user:pass@api.example/v1', 'moonshotai/kimi-k3', 'Base URL cannot include a username or password.'],
    ['https://api.example/v1?key=x', 'moonshotai/kimi-k3', 'Base URL cannot include a query or fragment.'],
    ['https://api.example/v1#frag', 'moonshotai/kimi-k3', 'Base URL cannot include a query or fragment.'],
    ['https://localhost/v1', 'moonshotai/kimi-k3', 'Base URL cannot use a local or private address.'],
    ['https://10.0.0.5/v1', 'moonshotai/kimi-k3', 'Base URL cannot use a local or private address.'],
    [`https://api.example/${'x'.repeat(200)}`, 'moonshotai/kimi-k3', 'A base URL has at most 200 characters.'],
    ['https://api.example/v1', 'bad model id', 'A model id uses only letters, digits, ., _, :, /, @, + and -.'],
  ])('keeps Save disabled and explains invalid URL/model %s', async (baseUrl, model, message) => {
    await open(emptyConfig);
    chooseProvider('openai-compatible');
    fill(input('API key'), 'sk-test-1234abcd');
    fill(browser.document.body.querySelector('input[placeholder="https://integrate.api.nvidia.com/v1"]') as FakeElement, baseUrl);
    fill(browser.document.body.querySelector('input[placeholder="moonshotai/kimi-k3"]') as FakeElement, model);
    expect(saveButton().disabled).toBe(true);
    expect(textOf(formProblem())).toBe(message);
  });

  it('saves a trimmed compatible-provider draft with its URL slash intact', async () => {
    const save = vi.spyOn(api, 'saveMyAiKey').mockResolvedValue({ provider: 'openai-compatible', hint: 'abcd', baseUrl: 'https://integrate.api.nvidia.com/v1', model: 'moonshotai/kimi-k3' });
    await open(emptyConfig);
    chooseProvider('openai-compatible');
    fill(input('API key'), '  sk-test-1234abcd  ');
    fill(browser.document.body.querySelector('input[placeholder="https://integrate.api.nvidia.com/v1"]') as FakeElement, '  https://integrate.api.nvidia.com/v1/  ');
    fill(browser.document.body.querySelector('input[placeholder="moonshotai/kimi-k3"]') as FakeElement, ' moonshotai/kimi-k3 ');
    expect(saveButton().disabled).toBe(false);
    saveButton().click();
    await tick();
    expect(save).toHaveBeenCalledWith({
      apiKey: 'sk-test-1234abcd', provider: 'openai-compatible', baseUrl: 'https://integrate.api.nvidia.com/v1/', model: 'moonshotai/kimi-k3',
    });
  });

  it('keeps the Anthropic request free of compatible-provider fields', async () => {
    const save = vi.spyOn(api, 'saveMyAiKey').mockResolvedValue({ provider: 'anthropic', hint: 'abcd', baseUrl: null, model: null });
    await open(emptyConfig);
    fill(input('API key'), '  sk-test-1234abcd  ');
    saveButton().click();
    await tick();
    expect(save).toHaveBeenCalledWith({ apiKey: 'sk-test-1234abcd', provider: 'anthropic' });
  });

  it('shows the fixed sentence for a provider/model rejection', async () => {
    vi.spyOn(api, 'saveMyAiKey').mockRejectedValueOnce(new ApiError(400, 'ai_model_invalid', 'ai_model_invalid'));
    await open(emptyConfig);
    chooseProvider('openai-compatible');
    fill(input('API key'), 'sk-test-1234abcd');
    fill(browser.document.body.querySelector('input[placeholder="https://integrate.api.nvidia.com/v1"]') as FakeElement, 'https://api.example/v1');
    fill(browser.document.body.querySelector('input[placeholder="moonshotai/kimi-k3"]') as FakeElement, 'moonshotai/kimi-k3');
    saveButton().click();
    await tick();
    expect(textOf(formProblem())).toBe('The provider does not know this model or this address. Check the base URL and the model.');
  });

  it('keeps saved model and endpoint text out of the DOM parser', async () => {
    const model = '<img src=x onerror=alert(1)>/moonshot';
    const baseUrl = 'https://<img src=x onerror=alert(1)>@api.example/v1';
    await open({ ...config, provider: 'openai-compatible', myKey: { provider: 'openai-compatible', hint: '4f2a', baseUrl, model, createdAt: 1, lastUsedAt: null } });
    expect(browser.document.body.querySelectorAll('img')).toHaveLength(0);
    expect(textOf(browser.document.body.querySelector('.ai-key-line'))).toContain(model);
    expect(browser.document.body.querySelector('input[placeholder="https://integrate.api.nvidia.com/v1"]')?.value).toBe(baseUrl);
  });
});
