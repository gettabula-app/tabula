import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, type AdminAi } from '../src/api';
import { aiAdminPanel } from '../src/ui/ai';
import type { AdminKit } from '../src/ui/tokens';
import { FakeEvent, FakeElement, flush, installFakeBrowser, textOf, type as typeInto, type FakeBrowser } from './fake-dom';

let browser: FakeBrowser;
let settings: AdminAi;

const blank = (): AdminAi => ({
  enabled: true,
  features: ['generate', 'summarise', 'cluster'],
  model: 'claude-opus-5-5',
  personalKeys: true,
  membersOnly: false,
  limits: { perPersonHour: 20, perWorkspaceHour: 200 },
  hasSecret: true,
  creditsActive: false,
  key: null,
});

const kit: AdminKit = {
  head: () => document.createElement('div') as never,
  loadList: (_box, fetchData, show) => {
    void fetchData().then(show);
    return () => undefined;
  },
  change: async (run) => {
    try {
      await run();
      return true;
    } catch {
      return false;
    }
  },
  armable: () => document.createElement('button') as never,
  emptyLine: (text) => {
    const line = document.createElement('p');
    line.textContent = text;
    return line as never;
  },
};

beforeEach(() => {
  browser = installFakeBrowser();
  settings = blank();
  vi.spyOn(api, 'adminAi').mockImplementation(async () => settings);
});
afterEach(() => {
  browser.uninstall();
  vi.restoreAllMocks();
});

const provider = (panel: FakeElement) => panel.querySelector('select[aria-label="Provider"]') as FakeElement;
const chooseProvider = (panel: FakeElement, value: string) => {
  provider(panel).value = value;
  provider(panel).dispatchEvent(new FakeEvent('change'));
};
const fill = (field: FakeElement, value: string) => typeInto(field, value);

async function mountPanel() {
  const panel = aiAdminPanel(kit) as unknown as FakeElement;
  await flush();
  return panel;
}

describe('the workspace compatible-provider key settings', () => {
  it('explains that credits will be used until a workspace key is added', async () => {
    settings.creditsActive = true;
    const panel = await mountPanel();
    expect(textOf(panel)).toContain('AI credits are used until you add a key.');
    expect(textOf(panel)).toContain('People can run AI with their own key or AI credits.');
    expect(textOf(panel)).not.toContain('only people with a key of their own can run AI features');
  });

  it('hides the credits note when a workspace key exists', async () => {
    settings.creditsActive = true;
    settings.key = { provider: 'anthropic', hint: 'abcd', baseUrl: null, model: null, createdAt: 1, lastUsedAt: null, readable: true };
    const panel = await mountPanel();
    expect(textOf(panel)).not.toContain('AI credits are used until you add a key.');
  });

  it('shows the saved model as a fact instead of the Anthropic model selector', async () => {
    settings.key = {
      provider: 'openai-compatible', hint: 'abcd', baseUrl: 'https://integrate.api.nvidia.com/v1', model: 'moonshotai/kimi-k3', createdAt: 1, lastUsedAt: null, readable: true,
    };
    const panel = await mountPanel();
    expect(panel.querySelector('select[aria-label="Model"]')).toBeNull();
    expect(textOf(panel)).toContain('moonshotai/kimi-k3');
    expect(textOf(panel)).toContain('From the key');
    expect(provider(panel).value).toBe('openai-compatible');
    expect(panel.querySelector('input[placeholder="https://integrate.api.nvidia.com/v1"]')?.value).toBe('https://integrate.api.nvidia.com/v1');
  });

  it('keeps hostile saved endpoint and model strings in values and text nodes', async () => {
    const model = '<img src=x onerror=alert(1)>/moonshot';
    const baseUrl = 'https://<img src=x onerror=alert(1)>@api.example/v1';
    settings.key = { provider: 'openai-compatible', hint: 'abcd', baseUrl, model, createdAt: 1, lastUsedAt: null, readable: true };
    const panel = await mountPanel();
    expect(panel.querySelectorAll('img')).toHaveLength(0);
    expect(textOf(panel)).toContain(model);
    expect(panel.querySelector('input[placeholder="https://integrate.api.nvidia.com/v1"]')?.value).toBe(baseUrl);
  });

  it('sends the trimmed compatible-provider fields with no extra key fields', async () => {
    const next = blank();
    const update = vi.spyOn(api, 'updateAdminAi').mockResolvedValue(next);
    const panel = await mountPanel();
    chooseProvider(panel, 'openai-compatible');
    fill(panel.querySelectorAll('input').find((field) => field.getAttribute('aria-label') === 'Workspace API key')!, '  sk-test-1234abcd  ');
    fill(panel.querySelector('input[placeholder="https://integrate.api.nvidia.com/v1"]') as FakeElement, '  https://integrate.api.nvidia.com/v1/  ');
    fill(panel.querySelector('input[placeholder="moonshotai/kimi-k3"]') as FakeElement, ' moonshotai/kimi-k3 ');
    const save = panel.querySelectorAll('button').find((button) => textOf(button) === 'Save key')!;
    expect(save.disabled).toBe(false);
    save.click();
    await flush();
    expect(update).toHaveBeenCalledWith({
      apiKey: 'sk-test-1234abcd', provider: 'openai-compatible', baseUrl: 'https://integrate.api.nvidia.com/v1/', keyModel: 'moonshotai/kimi-k3',
    });
  });
});
