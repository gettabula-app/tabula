// SVG for a Markdown block's drawing items (src/markdown-layout.ts). Plain SVG elements only (text, rect, line, path): no foreignObject, so the canvas,
// the SVG export and the PNG export draw the same thing, and nothing written in the Markdown can become anything else than escaped text and numbers.

import { escapeXml } from './text';
import type { MdItem } from './markdown-layout';

const n = (v: number) => Math.round(v * 100) / 100;

export const MD_MONO_FAMILY = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';

export interface MdPaint {
  /** A colour already checked by safeColor (shared/colors.mjs). */
  color: string;
  /** The font-family attribute value for the object's face (src/fonts.ts). */
  family: string;
  /** The object's id: a click on a link or a task box names the block it belongs to (the app acts only on a selected block). */
  owner: string;
}

/** Opacity of the strokes and tints that are drawn in the text colour, so every theme and every text colour gets a matching quiet tone. */
const TONE = { code: 0.1, quote: 0.4, rule: 0.55, table: 0.3, link: 1, strike: 1, box: 0.7 } as const;

export function mdItemsMarkup(items: readonly MdItem[], paint: MdPaint): string {
  const color = escapeXml(paint.color);
  const family = escapeXml(paint.family);
  const mono = escapeXml(MD_MONO_FAMILY);
  const owner = escapeXml(paint.owner);
  let out = '';
  for (const i of items) {
    switch (i.k) {
      case 'text':
        out += `<text x="${n(i.x)}" y="${n(i.y)}" font-family="${i.mono ? mono : family}" font-size="${n(i.size)}" font-weight="${i.weight}"${i.italic ? ' font-style="italic"' : ''} fill="${color}"${i.dim ? ' fill-opacity="0.62"' : ''} xml:space="preserve">${escapeXml(i.s)}</text>`;
        break;
      case 'rect':
        out += `<rect x="${n(i.x)}" y="${n(i.y)}" width="${n(i.w)}" height="${n(i.h)}" rx="${i.tone === 'code' ? 4 : 1}" fill="${color}" fill-opacity="${TONE[i.tone]}"/>`;
        break;
      case 'line':
        out += `<line x1="${n(i.x1)}" y1="${n(i.y1)}" x2="${n(i.x2)}" y2="${n(i.y2)}" stroke="${color}" stroke-opacity="${TONE[i.tone]}" stroke-width="${i.tone === 'rule' ? 1.5 : 1}"/>`;
        break;
      case 'check': {
        out += `<rect x="${n(i.x)}" y="${n(i.y)}" width="${n(i.size)}" height="${n(i.size)}" rx="3" fill="${i.done ? color : 'none'}" fill-opacity="${i.done ? 0.9 : 1}" stroke="${color}" stroke-width="1.5"/>`;
        if (i.done) {
          const s = i.size;
          out += `<path d="M${n(i.x + s * 0.24)} ${n(i.y + s * 0.52)} L${n(i.x + s * 0.43)} ${n(i.y + s * 0.72)} L${n(i.x + s * 0.78)} ${n(i.y + s * 0.3)}" fill="none" stroke="var(--canvas, #FFFFFF)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`;
        }
        break;
      }
      case 'picture':
        out += `<rect x="${n(i.x)}" y="${n(i.y)}" width="${n(i.w)}" height="${n(i.h)}" rx="3" fill="none" stroke="${color}" stroke-opacity="${TONE.box}" stroke-dasharray="4 3"/>`;
        out += `<text x="${n(i.x + 6)}" y="${n(i.y + i.h * 0.68)}" font-family="${family}" font-size="${n(i.h * 0.55)}" fill="${color}" fill-opacity="0.7" xml:space="preserve">${escapeXml(`[image: ${i.alt}]`)}</text>`;
        break;
      case 'hit': {
        const rect = `<rect x="${n(i.x)}" y="${n(i.y)}" width="${n(i.w)}" height="${n(i.h)}" fill="transparent"${i.task !== undefined ? ` data-md-owner="${owner}" data-md-task="${Math.trunc(i.task)}"` : ''}/>`;
        // A link is a real anchor: in an exported SVG it opens in its own tab, on the canvas the app lets it through only for a selected block (docs/markdown-blocks.md)
        out += i.link
          ? `<a data-md-owner="${owner}" data-md-kind="${i.link.kind}" href="${escapeXml(i.link.href)}"${i.link.kind === 'web' ? ' target="_blank" rel="noopener noreferrer"' : ''}>${rect}</a>`
          : rect;
        break;
      }
    }
  }
  return out;
}
