import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const trackerCss = readFileSync(new URL('../src/tracker/ui/tracker.css', import.meta.url), 'utf8');
const ticketCss = readFileSync(new URL('../src/tracker/ui/ticket-page.css', import.meta.url), 'utf8');
const ticketPage = readFileSync(new URL('../src/tracker/ui/ticket-page.ts', import.meta.url), 'utf8');

describe('M-S5 tracker styling', () => {
  it('uses serif tracker and ticket titles and visible ticket property labels', () => {
    expect(trackerCss).toContain('font: 400 28px/1.15 var(--font-serif)');
    expect(ticketCss).toContain('font-family: var(--font-serif); font-size: 34px; font-weight: 400; line-height: 1.15;');
    expect(ticketCss).toContain('.trk.tk-page:not(.tk-page--peek) .tk-properties { position: sticky; top: 16px; }');
    expect(ticketCss).toContain('.trk.tk-page .tk-property-name');
    expect(ticketPage).toContain("button('More properties', 'tk-properties-more-toggle'");
  });

  it('keeps selected rows soft, fields on a resting rule and sub-issue progress as a bar', () => {
    expect(trackerCss).toContain(".trk .trk-list-row[aria-selected='true'] { background: color-mix(in srgb, var(--trk-text) 6%, var(--trk-ground)); }");
    expect(ticketCss).toContain('box-shadow: inset 0 -1px 0 var(--field-rule)');
    expect(ticketCss).toContain('.trk.tk-page .tk-subissue-meter { display: block; width: min(180px, 100%); height: 4px;');
    expect(ticketPage).toContain("role: 'progressbar'");
  });
});
