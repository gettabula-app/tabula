import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { contrast, THEMES } from '../src/themes';

const css = readFileSync(new URL('../src/tracker/ui/tracker.css', import.meta.url), 'utf8');
const ticketCss = readFileSync(new URL('../src/tracker/ui/ticket-page.css', import.meta.url), 'utf8');
const adjacentCss = [
  readFileSync(new URL('../src/tracker/ui/inbox.css', import.meta.url), 'utf8'),
  readFileSync(new URL('../src/tracker/ui/link-dialog.css', import.meta.url), 'utf8'),
  readFileSync(new URL('../src/tracker/ui/unlink-confirm.css', import.meta.url), 'utf8'),
];
const appCss = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
const trackerStyles = [css, ticketCss, ...adjacentCss];

function declarations(source: string, selector: string): string {
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const rule = [...withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find(([, header]) => header.trim() === selector);
  if (!rule) throw new Error(`missing CSS rule: ${selector}`);
  return rule[2];
}

function mixHex(foreground: string, background: string, foregroundShare: number): string {
  const channels = (hex: string) => [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16));
  const from = channels(foreground);
  const to = channels(background);
  return `#${from.map((channel, index) => Math.round(channel * foregroundShare + to[index] * (1 - foregroundShare)).toString(16).padStart(2, '0')).join('')}`;
}

function rules(source: string): Array<{ selector: string; body: string }> {
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, '');
  return [...withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .map(([, selector, body]) => ({ selector: selector.trim(), body }))
    .filter(({ selector }) => !selector.startsWith('@'));
}

function lineWidthViolations(source: string): string[] {
  const violations: string[] = [];
  for (const { selector, body } of rules(source)) {
    for (const declaration of body.split(';')) {
      const split = declaration.indexOf(':');
      if (split < 0) continue;
      const property = declaration.slice(0, split).trim().toLocaleLowerCase();
      const value = declaration.slice(split + 1).trim();
      if (/^border(?:-(?:top|right|bottom|left))?$/.test(property) || property === 'border-width' || /^border-(?:top|right|bottom|left)-width$/.test(property) || property === 'outline' || property === 'outline-width') {
        const width = Number.parseFloat(value.match(/-?(?:\d+\.?\d*|\.\d+)px/)?.[0] ?? '0');
        // The shared 2px focus ring is the sole intentional exception. Decorative rules stay at 1px.
        if (width > 1 && !(property.startsWith('outline') && width === 2 && selector.includes(':focus-visible'))) {
          violations.push(`${selector}: ${property} ${value}`);
        }
      }
      if (property === 'box-shadow') {
        const normalized = value.replace(/color-mix\([^)]*\)/g, 'color');
        for (const shadow of normalized.split(',')) {
          const lengths = [...shadow.matchAll(/(-?(?:\d+\.?\d*|\.\d+))px/g)].map((match) => Number(match[1]));
          const spread = lengths.length >= 4 ? Math.abs(lengths[3]) : 0;
          const stripe = lengths.length >= 3 && Math.abs(lengths[2]) === 0 && Math.max(Math.abs(lengths[0] ?? 0), Math.abs(lengths[1] ?? 0)) > 1;
          if (spread > 1 || stripe) violations.push(`${selector}: box-shadow ${shadow.trim()}`);
        }
      }
    }
  }
  return violations;
}

function highWeightViolations(source: string): string[] {
  const violations: string[] = [];
  for (const { selector, body } of rules(source)) {
    for (const declaration of body.split(';')) {
      const split = declaration.indexOf(':');
      if (split < 0) continue;
      const property = declaration.slice(0, split).trim().toLocaleLowerCase();
      const value = declaration.slice(split + 1).trim();
      const weight = property === 'font-weight'
        ? Number(value)
        : property === 'font' ? Number(value.match(/(?:^|\s)(\d{3})(?=\s)/)?.[1] ?? 0) : 0;
      if (weight > 600) violations.push(`${selector}: ${property} ${value}`);
    }
  }
  return violations;
}

describe('tracker UI styles', () => {
  it('uses app theme variables instead of fixed colors and scopes every selector to .trk', () => {
    for (const source of trackerStyles) {
      const uncommented = source.replace(/\/\*[\s\S]*?\*\//g, '');
      expect(uncommented).not.toMatch(/#[\da-f]{3,8}\b|\b(?:rgb|rgba|hsl|hsla)\s*\(/i);
      expect(uncommented).not.toMatch(/(?<![a-z-])(?:white|black|red|blue|green|yellow|orange|purple|gray|grey|silver|maroon|navy)(?![a-z-])/i);
      expect(uncommented).not.toMatch(/Bodoni|Georgia/i);
    }
    const selectors = trackerStyles.flatMap((source) => rules(source).map(({ selector }) => selector));
    expect(selectors.length).toBeGreaterThan(20);
    for (const selector of selectors) for (const part of selector.split(',')) expect(part.trim()).toContain('.trk');
  });

  it('keeps decorative rules at 1px, cursor marks at a 1px inset outline, and tracker weights at 600 or below', () => {
    expect(trackerStyles.flatMap(lineWidthViolations)).toEqual([]);
    expect(trackerStyles.flatMap(highWeightViolations)).toEqual([]);
    expect(css).toContain('inset 0 0 0 1px var(--trk-focus)');
    expect(css).not.toMatch(/inset\s+3px\s+0\s+0/);
    expect(declarations(ticketCss, '.trk.tk-page .tk-field-button')).toMatch(/border:\s*0/);
    expect(declarations(ticketCss, '.trk.tk-page .tk-field-button')).toMatch(/background:\s*transparent/);
    const newComments = declarations(ticketCss, '.trk.tk-page .tk-new-comments');
    expect(newComments).toMatch(/background:\s*var\(--trk-ground\)/);
    expect(newComments).toMatch(/color:\s*var\(--trk-text\)/);
    expect(ticketCss).toContain('.trk.tk-page--peek .tk-title, .trk.tk-page--peek .tk-title-input { font-size: 22px; }');
  });

  it('keeps radius fallbacks, focus, phone sheet touch sizes, reduced motion, and forced colors', () => {
    expect(css).toContain('var(--radius-xs, 4px)');
    expect(css).toContain('var(--radius-sm, 8px)');
    expect(css).toContain('var(--radius-md, 12px)');
    expect(css).toContain('var(--radius-lg, 14px)');
    expect(css).toContain('outline: 2px solid var(--trk-focus)');
    expect(css).toContain('outline-offset: 2px');
    expect(css).toContain(".trk .trk-list-row[aria-selected='true'] { box-shadow: inset 0 0 0 1px var(--trk-focus); }");
    expect(css).toContain('(pointer: coarse), (max-width: 860px)');
    expect(css).toMatch(/\.trk input, \.trk select, \.trk \.trk-picker-search,[\s\S]*?\.trk-filter-input \{ min-height: 44px; \}/);
    expect(css).toMatch(/\.trk \.trk-filter-button,[\s\S]*?\.trk-gallery-picker-button \{ min-height: 44px; \}/);
    expect(css).toContain('width: 280px; min-width: 280px');
    expect(css).toContain('.trk-board-lanes.is-phone-lane .trk-board-lane');
    expect(css).toContain('min-height: 48px');
    expect(css).toContain('prefers-reduced-motion: reduce');
    expect(css).toContain('forced-colors: active');
  });

  it('keeps muted text at 4.5:1 and focus at 3:1 on all five tracker themes', () => {
    expect(declarations(css, '.trk')).toMatch(/--trk-muted:\s*var\(--graphite\)/);
    expect(declarations(css, '.trk')).toMatch(/--trk-focus:\s*var\(--ink\)/);
    expect(declarations(css, '.trk')).toMatch(/--trk-cursor:\s*color-mix\(in srgb, var\(--canvas\) 16%, var\(--trk-ground\)\)/);
    expect(declarations(ticketCss, '.trk.tk-page .tk-property-label')).toMatch(/color:\s*var\(--trk-muted\)/);
    expect(declarations(ticketCss, '.trk.tk-page')).toMatch(/background:\s*var\(--paper-hi,\s*var\(--paper\)\)/);
    expect(declarations(appCss, '.tray')).toMatch(/background:\s*var\(--tray\)/);

    const trayErrors = declarations(css, '.trk-inline-error, .trk-create-reason');
    expect(trayErrors).toMatch(/color:\s*var\(--tray-text\)/);
    expect(trayErrors).toMatch(/border-radius:\s*var\(--radius-xs\)/);
    expect(trayErrors).toMatch(/color-mix\(in srgb, var\(--danger\) 80%, var\(--tray-text\)\)/);
    expect(declarations(css, '.trk-inline-error::before, .trk-create-reason::before')).toMatch(/content:\s*'!'/);
    const pending = declarations(ticketCss, '.trk.tk-page .tk-comment-row.pending');
    expect(pending).not.toMatch(/opacity\s*:/);

    for (const theme of THEMES) {
      expect(contrast(theme.vars['--graphite'], theme.vars['--paper']), `${theme.id} muted on paper`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(theme.vars['--ink'], theme.vars['--paper']), `${theme.id} ticket foreground on ground`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(theme.vars['--ink'], theme.vars['--paper']), `${theme.id} focus on paper`).toBeGreaterThanOrEqual(3);
      const cursorGround = mixHex(theme.vars['--canvas'], theme.vars['--paper'], 0.16);
      expect(contrast(theme.vars['--graphite'], cursorGround), `${theme.id} muted on cursor`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(theme.vars['--ink'], cursorGround), `${theme.id} focus on cursor`).toBeGreaterThanOrEqual(3);
      expect(contrast(theme.vars['--tray-muted'], theme.vars['--tray']), `${theme.id} muted on tray`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(theme.vars['--tray-text'], theme.vars['--tray']), `${theme.id} focus on tray`).toBeGreaterThanOrEqual(3);
      const trayCursor = mixHex(theme.vars['--tray-text'], theme.vars['--tray'], 0.01);
      expect(contrast(theme.vars['--tray-muted'], trayCursor), `${theme.id} muted on tray cursor`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(theme.vars['--tray-text'], trayCursor), `${theme.id} focus on tray cursor`).toBeGreaterThanOrEqual(3);
      for (const label of ['inline error', 'offline create reason']) {
        expect(contrast(theme.vars['--tray-text'], theme.vars['--tray']), `${theme.id} ${label} on tray`).toBeGreaterThanOrEqual(4.5);
      }
      const dangerMarker = mixHex(theme.vars['--danger'], theme.vars['--tray-text'], 0.8);
      expect(contrast(dangerMarker, theme.vars['--tray']), `${theme.id} danger marker on tray`).toBeGreaterThanOrEqual(3);
    }
  });
});
