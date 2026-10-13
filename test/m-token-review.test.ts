import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { THEMES, contrast } from '../src/themes';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (file: string) => readFileSync(join(ROOT, file), 'utf8');
const cssFiles = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const path = join(dir, entry.name);
  if (entry.isDirectory()) return cssFiles(path);
  return entry.isFile() && entry.name.endsWith('.css') ? [path] : [];
});
const allCss = () => cssFiles(join(ROOT, 'src')).map((file) => readFileSync(file, 'utf8')).join('\n');

function mixHex(a: string, pct: number, b: string): string {
  const proportion = pct / 100;
  const channels = [1, 3, 5].map((offset) => {
    const ca = Number.parseInt(a.slice(offset, offset + 2), 16);
    const cb = Number.parseInt(b.slice(offset, offset + 2), 16);
    return Math.round(ca * proportion + cb * (1 - proportion)).toString(16).padStart(2, '0');
  });
  return `#${channels.join('').toUpperCase()}`;
}

function scrimOver(background: string, scrim: string): string {
  const match = scrim.match(/^rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([\d.]+)\s*\)$/i);
  if (!match) throw new Error(`Expected an rgba scrim, got ${scrim}`);
  const [, red, green, blue, alpha] = match;
  const overlay = [red, green, blue].map(Number);
  const opacity = Number(alpha);
  const base = [1, 3, 5].map((offset) => Number.parseInt(background.slice(offset, offset + 2), 16));
  return `#${base.map((channel, index) => Math.round(channel * (1 - opacity) + overlay[index] * opacity).toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

const parseRules = (css: string) => [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .map(([, selectors, body]) => ({ selectors: selectors.trim(), body }));

describe('M token review findings', () => {
  it.each(THEMES)('$id danger button text clears 4.5:1 at rest and hover', (theme) => {
    const rest = contrast(theme.vars['--on-danger'], theme.vars['--danger']);
    const hoverFill = mixHex(theme.vars['--danger'], 95, theme.vars['--on-danger']);
    const hover = contrast(theme.vars['--on-danger'], hoverFill);
    expect(rest, `${theme.id} rest`).toBeGreaterThanOrEqual(4.5);
    expect(hover, `${theme.id} hover`).toBeGreaterThanOrEqual(4.5);
  });

  it('uses the danger text token for solid danger buttons and a contrast-safe hover mix', () => {
    const styles = read('src/styles.css');
    expect(styles).toMatch(/\.btn\.danger\s*\{[^}]*background:\s*var\(--danger\)[^}]*color:\s*var\(--on-danger\)/);
    expect(styles).toMatch(/\.btn\.danger:hover\s*\{[^}]*color-mix\(in srgb, var\(--danger\) 95%, var\(--on-danger\)\)/);
    expect(styles).toMatch(/\.modal \.btn\.armed,\s*\.modal \.btn\.danger\s*\{[^}]*background:\s*var\(--danger\)[^}]*color:\s*var\(--on-danger\)/);
    expect(styles).toMatch(/\.modal \.btn\.armed:not\(:disabled\):hover, \.modal \.btn\.danger:not\(:disabled\):hover\s*\{[^}]*color-mix\(in srgb, var\(--danger\) 95%, var\(--on-danger\)\)/);
    expect(styles).toMatch(/\.popover \.btn\.armed, \.popover \.btn\.danger\s*\{[^}]*color:\s*var\(--on-danger\)/);
    expect(read('src/ui/admin.css')).toMatch(/\.admin \.btn\.armed:not\(:disabled\):hover\s*\{[^}]*background:\s*var\(--danger\);\s*color:\s*var\(--on-danger\)/);
  });

  it.each(THEMES)('$id placeholders clear 4.5:1 on every tinted field surface', (theme) => {
    const trayPlaceholder = mixHex(theme.vars['--tray-muted'], 90, theme.vars['--tray-text']);
    const trayFill = mixHex(theme.vars['--tray-text'], 6, theme.vars['--tray']);
    const trayHoverFill = mixHex(theme.vars['--tray-text'], 9, theme.vars['--tray']);
    const paperPlaceholder = theme.vars['--ink'];
    const paperFill = mixHex(theme.vars['--ink'], 6, theme.vars['--paper']);
    const surfaces = [
      ['shared tray fields', trayPlaceholder, trayFill],
      ['shared tray fields on hover', trayPlaceholder, trayHoverFill],
      ['chat composer on tray-2', trayPlaceholder, theme.vars['--tray-2']],
      ['AI bar field over tray', trayPlaceholder, trayFill],
      ['error tray field', trayPlaceholder, mixHex(theme.vars['--danger'], 10, theme.vars['--tray'])],
      ...['kanban add-card', 'home search', 'poll composer', 'admin', 'sign-in', 'move-to sheet'].map((name) => [name, paperPlaceholder, paperFill] as const),
    ] as const;

    for (const [, foreground, fill] of surfaces) {
      expect(contrast(foreground, fill)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('sets explicit high-contrast placeholders for the paper and tray field rules', () => {
    const css = allCss();
    expect(read('src/styles.css')).toMatch(/--placeholder:\s*color-mix\(in srgb, var\(--tray-muted\) 90%, var\(--tray-text\)\)/);
    expect(css).toMatch(/input::placeholder,\s*textarea::placeholder\s*\{[^}]*color:\s*var\(--placeholder\);[^}]*opacity:\s*1/);
    for (const [file, selector] of [
      ['src/ui/kanban.css', '.k-input::placeholder'],
      ['src/ui/home.css', '.home .input::placeholder'],
      ['src/ui/polls.css', '.poll-compose .input::placeholder'],
      ['src/ui/container-sheet.css', '.ks-input::placeholder'],
    ] as const) {
      expect(read(file)).toMatch(new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{[^}]*color:\\s*var\\(--placeholder\\)`));
    }
    expect(read('src/ui/admin.css')).toMatch(/\.admin \.input\s*\{[^}]*--placeholder:\s*var\(--ink\)/);
    expect(read('src/ui/signin.css')).toMatch(/\.signin \.input\s*\{[^}]*--placeholder:\s*var\(--ink\)/);
  });

  it('uses the tray-muted modal label token without mixing it toward the tray', () => {
    const styles = read('src/styles.css');
    // Slice 2 widened the selector list (ai/tokens/backups labels); the pin is on the colour: modal labels use --tray-muted unmixed.
    expect(styles).toMatch(/\.modal :is\([^)]*\.field-label[^)]*\)[^{]*\{[^}]*color:\s*var\(--tray-muted\)/);
    expect(styles).not.toMatch(/\.modal :is\([^)]*\.field-label[^)]*\)[^{]*\{[^}]*color-mix/);
    for (const theme of THEMES) {
      expect(contrast(theme.vars['--tray-muted'], theme.vars['--tray'])).toBeGreaterThanOrEqual(4.5);
    }
  });

  it.each(THEMES)('$id scrim clears 1.3:1 against paper and canvas', (theme) => {
    for (const surface of ['--paper', '--canvas'] as const) {
      const renderedScrim = scrimOver(theme.vars[surface], theme.vars['--scrim']);
      expect(contrast(renderedScrim, theme.vars[surface])).toBeGreaterThanOrEqual(1.3);
    }
  });

  it('uses the scrim token for overlays and keeps elevation shadows off surface and text colors', () => {
    const rules = parseRules(allCss());
    const shadowRules = rules.flatMap((rule) => [...rule.body.matchAll(/box-shadow\s*:\s*([^;]+);/g)].map(([, value]) => ({ ...rule, value })));
    // Focus indicators (:focus, :focus-within, :focus-visible) are keyboard indicators, not elevation. It keeps its high-contrast color; elevation shadows use --shade.
    const nonFocusShadows = shadowRules.filter(({ selectors }) => !/:focus(?:-within|-visible)?\b/.test(selectors));
    const rawSurfaceColor = /var\(\s*--(?:tray|ink|tray-text)(?:\s|,|\))/;
    expect(nonFocusShadows.filter(({ value }) => rawSurfaceColor.test(value))).toEqual([]);

    for (const selector of ['.modal-back', '.trk-modal.modal-back', '.chat-dock-scrim', '.ks-scrim']) {
      const relatedRules = rules.filter((candidate) => candidate.selectors.split(',').map((value) => value.trim()).includes(selector));
      expect(relatedRules.length).toBeGreaterThan(0);
      expect(relatedRules.some((rule) => /background:\s*var\(--scrim\)/.test(rule.body))).toBe(true);
      expect(relatedRules.some((rule) => rawSurfaceColor.test(rule.body))).toBe(false);
    }
  });

  it('keeps canvas badge colors separate from chrome signal colors', () => {
    const expectedSignals = {
      default: { chrome: ['#111111', '#FFFFFF'], canvas: ['#FFD23F', '#18212B'] },
      ayu: { chrome: ['#FFCC66', '#1F2430'], canvas: ['#FFCC66', '#1F2430'] },
      kanagawa: { chrome: ['#E6C384', '#1F1F28'], canvas: ['#E6C384', '#1F1F28'] },
      matrix: { chrome: ['#00FF41', '#021004'], canvas: ['#00FF41', '#021004'] },
      evergreen: { chrome: ['#E0B040', '#14301F'], canvas: ['#E0B040', '#14301F'] },
    } as const;
    for (const theme of THEMES) {
      const expected = expectedSignals[theme.id as keyof typeof expectedSignals];
      expect(theme.vars['--signal'], `${theme.id} chrome signal`).toBe(expected.chrome[0]);
      expect(theme.vars['--on-signal'], `${theme.id} chrome signal text`).toBe(expected.chrome[1]);
      expect(theme.vars['--canvas-signal'], `${theme.id} canvas signal`).toBe(expected.canvas[0]);
      expect(theme.vars['--on-canvas-signal'], `${theme.id} canvas signal text`).toBe(expected.canvas[1]);
    }

    const canvasSources = ['src/render.ts', 'src/markup.ts', 'src/ai-live-logic.ts'].map(read).join('\n');
    expect(canvasSources).toContain('--canvas-signal');
    expect(canvasSources).toContain('--on-canvas-signal');
    expect(canvasSources).not.toMatch(/var\(--(?:on-)?signal\b/);
  });

  it('adds a non-color cue to the no-votes warning state', () => {
    const styles = read('src/styles.css');
    expect(styles).toMatch(/\.votes-left\.none\s*\{[^}]*font-weight:\s*700[^}]*text-decoration:\s*underline[^}]*text-decoration-thickness:\s*2px/);
  });
});
