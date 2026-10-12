// The link card as SVG (proto/designer-preview/link-cards/SPEC.md): the three layouts and the states, drawn from the stored
// object in world units. Text is escaped real text; the preview image and the icon come only through the board's asset loader
// (a `blob:` URL of bytes fetched from our own asset route), never from the linked site.
import type { BaseObj } from './types';
import type { ImageState } from './image-loader';
import { escapeXml, fontCss, measure, wrap } from './text';
import { layoutOf, letterColour, letterOf, linkLabel, linkTooltip, linkView } from './link-cards';

export interface LinkCtx {
  /** The picture for an asset hash: its pixels, or why not yet. */
  assetState?: (o: BaseObj, hash: string) => ImageState;
  /** True in an export: no moving line and no hover chrome (the card is drawn as if its preview were in). */
  still?: boolean;
}

const n = (v: number) => Math.round(v * 100) / 100;
const FONT = "var(--ui, 'Instrument Sans', ui-sans-serif, system-ui, sans-serif)";
const INK = 'var(--ink, #18212B)';
const GRAPHITE = 'var(--graphite, #5B6672)';
const PAPER = 'var(--paper, #FFFFFF)';
const RULE = 'var(--canvas-rule, #C9D1DA)';
const TITLE_SIZE = 14;
const BODY_SIZE = 12.5;
const SMALL = 11;
const PAD_X = 14;
const IMAGE_COL = 110;

/** The lines of `text` within `width`, at most `max`; the last one ends with an ellipsis when there was more. */
export function clampLines(text: string, font: string, width: number, max: number): string[] {
  const all = wrap(text, font, width);
  if (all.length <= max) return all;
  const kept = all.slice(0, max);
  let last = kept[max - 1];
  while (last.length > 1 && measure(`${last}…`, font) > width) last = last.slice(0, -1);
  kept[max - 1] = `${last.trimEnd()}…`;
  return kept;
}

const text = (x: number, y: number, size: number, weight: number, fill: string, s: string, extra = '') =>
  `<text x="${n(x)}" y="${n(y)}" font-size="${size}" style="fill:${fill};font-family:${FONT};font-weight:${weight}"${extra}>${escapeXml(s)}</text>`;

function letterIcon(x: number, y: number, size: number, domain: string): string {
  const fs = Math.round(size * 0.62 * 10) / 10;
  return `<rect x="${n(x)}" y="${n(y)}" width="${size}" height="${size}" rx="4" fill="${letterColour(domain)}"/>` +
    `<text x="${n(x + size / 2)}" y="${n(y + size / 2)}" text-anchor="middle" dominant-baseline="central" font-size="${fs}" style="fill:#FFFFFF;font-family:${FONT};font-weight:700">${escapeXml(letterOf(domain))}</text>`;
}

/** The site icon at `size`, or the letter icon when there is none (or it is not here yet). */
function siteIcon(o: BaseObj, ctx: LinkCtx, x: number, y: number, size: number, domain: string): string {
  if (typeof o.icon === 'string' && ctx.assetState) {
    const s = ctx.assetState(o, o.icon);
    if (s.kind === 'ok') {
      return `<image href="${escapeXml(s.url)}" x="${n(x)}" y="${n(y)}" width="${size}" height="${size}" preserveAspectRatio="xMidYMid slice" clip-path="url(#${clipId(o, 'icon')})"/>`;
    }
  }
  return letterIcon(x, y, size, domain);
}

const clipId = (o: BaseObj, part: string) => `lc-${part}-${String(o.id).replace(/[^A-Za-z0-9_-]/g, '')}`;

export function linkMarkup(o: BaseObj, ctx: LinkCtx = {}): string {
  const v = linkView(o);
  const w = Math.max(1, o.w);
  const h = Math.max(1, o.h);
  const layout = layoutOf(w, h);
  const pending = v.state === 'pending' && !ctx.still;
  const showPreview = v.state === 'ok' || (ctx.still && v.state === 'pending');
  const domainLabel = v.domain || v.url;
  const fontTitle = fontCss('satoshi', TITLE_SIZE, 700);
  const fontBody = fontCss('satoshi', BODY_SIZE, 400);
  const fontSmall = fontCss('satoshi', SMALL, 400);
  const fontSite = fontCss('satoshi', SMALL, 600);

  // the picture, when there is one and it is here; while it loads its place stays (a light block), so the text does not jump
  let imageState: ImageState | null = null;
  if (showPreview && typeof o.image === 'string' && ctx.assetState) imageState = ctx.assetState(o, o.image);
  const hasImage = imageState !== null && imageState.kind !== 'failed' && layout !== 'compact';

  const parts: string[] = [];
  const body: string[] = [];
  const iconSize = layout === 'compact' ? 20 : 16;

  const clipIcon = (x: number, y: number, size: number) => `<clipPath id="${clipId(o, 'icon')}"><rect x="${n(x)}" y="${n(y)}" width="${size}" height="${size}" rx="4"/></clipPath>`;
  let iconDefs = '';

  if (layout === 'compact') {
    const iy = (h - iconSize) / 2;
    iconDefs = clipIcon(PAD_X, iy, iconSize);
    body.push(siteIcon(o, ctx, PAD_X, iy, iconSize, v.domain));
    const domainW = Math.min(110, measure(domainLabel, fontSmall));
    const tx = PAD_X + iconSize + 10;
    const titleW = Math.max(20, w - tx - PAD_X - domainW - 10);
    const heading = clampLines(v.heading, fontTitle, titleW, 1)[0] ?? '';
    body.push(text(tx, h / 2, TITLE_SIZE, 700, INK, heading, ' dominant-baseline="central"'));
    const domainShown = clampLines(domainLabel, fontSmall, 110, 1)[0] ?? '';
    body.push(text(w - PAD_X, h / 2, SMALL, 400, GRAPHITE, domainShown, ' text-anchor="end" dominant-baseline="central"'));
  } else {
    const large = layout === 'large';
    let top = 0;
    let textLeft = PAD_X;
    let textW = w - PAD_X * 2;
    if (hasImage && imageState) {
      if (large) {
        const natural = o.imageW && o.imageH ? (w * o.imageH) / o.imageW : (w * 9) / 16;
        const textBlock = 150;
        const ih = Math.max(40, Math.min(natural, w, h - textBlock));
        if (imageState.kind === 'ok') {
          body.push(`<image href="${escapeXml(imageState.url)}" x="0" y="0" width="${n(w)}" height="${n(ih)}" preserveAspectRatio="xMidYMid slice" clip-path="url(#${clipId(o, 'card')})"/>`);
        } else body.push(`<rect x="0" y="0" width="${n(w)}" height="${n(ih)}" fill="var(--canvas, #EEF1F4)"/>`);
        body.push(`<rect x="0" y="${n(ih)}" width="${n(w)}" height="1" fill="${RULE}"/>`);
        top = ih + 1;
      } else {
        const ix = w - IMAGE_COL;
        if (imageState.kind === 'ok') {
          body.push(`<image href="${escapeXml(imageState.url)}" x="${n(ix)}" y="0" width="${IMAGE_COL}" height="${n(h)}" preserveAspectRatio="xMidYMid slice" clip-path="url(#${clipId(o, 'card')})"/>`);
        } else body.push(`<rect x="${n(ix)}" y="0" width="${IMAGE_COL}" height="${n(h)}" fill="var(--canvas, #EEF1F4)"/>`);
        body.push(`<rect x="${n(ix)}" y="0" width="1" height="${n(h)}" fill="${RULE}"/>`);
        textW = ix - PAD_X * 2;
      }
    }
    const y0 = top + 12;
    // site row: icon and the site name in small capitals
    iconDefs = clipIcon(textLeft, y0, iconSize);
    body.push(siteIcon(o, ctx, textLeft, y0, iconSize, v.domain));
    const site = clampLines(v.siteName.toUpperCase(), fontSite, Math.max(20, textW - iconSize - 8), 1)[0] ?? '';
    body.push(text(textLeft + iconSize + 8, y0 + iconSize / 2, SMALL, 600, GRAPHITE, site, ' dominant-baseline="central" letter-spacing="0.66"'));
    // title: two lines; the address itself when there is no title yet
    const ty = y0 + iconSize + 8;
    const titleLines = clampLines(v.heading, fontTitle, textW, 2);
    titleLines.forEach((line, i) => body.push(text(textLeft, ty + TITLE_SIZE * 1.3 * i + TITLE_SIZE, TITLE_SIZE, 700, INK, line)));
    let cursor = ty + titleLines.length * TITLE_SIZE * 1.3 + 4;
    const domainBase = h - 12;
    // description (two lines in the large layout, and when there is no picture beside it), or the state line
    if (v.state === 'ok' && v.description) {
      const room = Math.floor((domainBase - SMALL - 4 - cursor) / (BODY_SIZE * 1.4));
      const max = Math.max(0, Math.min(large || !hasImage ? 2 : 1, room));
      clampLines(v.description, fontBody, textW, Math.max(1, max)).slice(0, max).forEach((line, i) => {
        body.push(text(textLeft, cursor + BODY_SIZE * 1.4 * i + BODY_SIZE, BODY_SIZE, 400, GRAPHITE, line));
      });
    } else if (v.state === 'pending' && !ctx.still) {
      body.push(text(textLeft, cursor + BODY_SIZE, BODY_SIZE, 400, GRAPHITE, 'Loading preview…'));
    } else if (v.state === 'failed') {
      body.push(text(textLeft, cursor + BODY_SIZE, BODY_SIZE, 400, GRAPHITE, 'No preview'));
    }
    const domainShown = clampLines(domainLabel, fontSmall, textW, 1)[0] ?? '';
    body.push(text(textLeft, domainBase, SMALL, 400, GRAPHITE, domainShown));
  }

  // the card: paper, a quiet 1px edge, content clipped to the corners
  parts.push(`<clipPath id="${clipId(o, 'card')}"><rect x="0" y="0" width="${n(w)}" height="${n(h)}" rx="4"/></clipPath>${iconDefs}`);
  parts.push(`<rect class="link-card-bg" x="0" y="0" width="${n(w)}" height="${n(h)}" rx="4" fill="${PAPER}"/>`);
  parts.push(`<g clip-path="url(#${clipId(o, 'card')})">${body.join('')}`);
  if (pending) {
    const span = Math.round(w * 0.65);
    parts.push(`<rect x="0" y="${n(h - 2)}" width="${n(w)}" height="2" fill="${RULE}"/><rect class="link-seg" x="0" y="${n(h - 2)}" width="${n(w * 0.35)}" height="2" fill="${INK}" fill-opacity="0.35" style="--span:${span}px"/>`);
  }
  parts.push('</g>');
  parts.push(`<rect class="link-card-edge" x="0.5" y="0.5" width="${n(w - 1)}" height="${n(h - 1)}" rx="4" fill="none" stroke="${RULE}" stroke-width="1"/>`);
  const label = escapeXml(linkLabel(o));
  const tip = escapeXml(linkTooltip(o));
  return `<g class="link-card" role="link" aria-label="${label}"><title>${tip}</title>${parts.join('')}</g>`;
}
