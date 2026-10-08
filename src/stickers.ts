// Stickers are icon objects from emoji sets, drawn in full colour. This module
// holds the pure rules (sets, sizes, id scoping); the drawer and reactions live in ui/stickers.ts.

import type { Obj } from './types';

export interface StickerSet { prefix: string; label: string; default?: true }

export const STICKER_SETS: StickerSet[] = [
  { prefix: 'fluent-emoji-flat', label: 'Fluent', default: true },
  { prefix: 'twemoji', label: 'Twemoji' },
  { prefix: 'noto', label: 'Noto' },
];

export const REACTIONS = [
  'fluent-emoji-flat:thumbs-up', 'fluent-emoji-flat:red-heart', 'fluent-emoji-flat:party-popper', 'fluent-emoji-flat:face-with-tears-of-joy',
  'fluent-emoji-flat:eyes', 'fluent-emoji-flat:fire', 'fluent-emoji-flat:rocket', 'fluent-emoji-flat:sparkles',
  'fluent-emoji-flat:clapping-hands', 'fluent-emoji-flat:thinking-face', 'fluent-emoji-flat:hundred-points', 'fluent-emoji-flat:check-mark-button',
  'fluent-emoji-flat:cross-mark', 'fluent-emoji-flat:raising-hands', 'fluent-emoji-flat:folded-hands', 'fluent-emoji-flat:star-struck',
];

export const STICKER_SIZE = 120;
export const REACTION_SIZE = 40;

export const isSticker = (o: Obj): boolean => o.type === 'icon' && o.sticker === true;

/** Size with the longest side at `longest`, keeping the icon's aspect ratio. */
export function stickerSize(width: number, height: number, longest = STICKER_SIZE): { w: number; h: number } {
  if (!(width > 0 && height > 0)) return { w: longest, h: longest };
  const ratio = width / height;
  return ratio >= 1 ? { w: longest, h: longest / ratio } : { w: longest * ratio, h: longest };
}

/**
 * Makes the ids a body defines unique to one object: `id`, `url(#x)` and `href="#x"`
 * (also `xlink:href`), quoted or not. References to ids the body does not define are left alone.
 */
export function scopeSvgIds(body: string, objectId: string): string {
  const defined = new Set<string>();
  for (const m of body.matchAll(/\sid\s*=\s*(["'])([^"']*)\1/g)) if (m[2]) defined.add(m[2]);
  if (!defined.size) return body;
  // Object ids reach us from peers and imported files, and this runs after the sanitiser: keep only id-safe characters.
  const prefix = `i${objectId.replace(/[^A-Za-z0-9_-]/g, '_')}-`;
  const scope = (id: string) => `${prefix}${id}`;
  return body
    .replace(/(\sid\s*=\s*)(["'])([^"']*)\2/g, (all, lead: string, q: string, id: string) => (defined.has(id) ? `${lead}${q}${scope(id)}${q}` : all))
    .replace(/(url\(\s*)(['"]?)#([^'")\s]+)\2(\s*\))/g, (all, pre: string, q: string, id: string, post: string) => (defined.has(id) ? `${pre}${q}#${scope(id)}${q}${post}` : all))
    .replace(/(\s(?:xlink:)?href\s*=\s*)(["'])#([^"']*)\2/g, (all, lead: string, q: string, id: string) => (defined.has(id) ? `${lead}${q}#${scope(id)}${q}` : all));
}
