// Minimal HTML head scanner for link previews. It intentionally reads only metadata, never builds a DOM or executes code.

const NAMED_ENTITIES = Object.freeze({
  amp: '&', AMP: '&', lt: '<', LT: '<', gt: '>', GT: '>', quot: '"', QUOT: '"', apos: "'", nbsp: '\u00a0',
  copy: '\u00a9', COPY: '\u00a9', reg: '\u00ae', REG: '\u00ae', trade: '\u2122', hellip: '\u2026',
  ndash: '\u2013', mdash: '\u2014', lsquo: '\u2018', rsquo: '\u2019', sbquo: '\u201a',
  ldquo: '\u201c', rdquo: '\u201d', bdquo: '\u201e', bull: '\u2022', middot: '\u00b7',
  laquo: '\u00ab', raquo: '\u00bb', euro: '\u20ac', pound: '\u00a3', yen: '\u00a5', cent: '\u00a2',
  eacute: '\u00e9', Eacute: '\u00c9', egrave: '\u00e8', Egrave: '\u00c8',
  aacute: '\u00e1', Aacute: '\u00c1', ouml: '\u00f6', Ouml: '\u00d6', uuml: '\u00fc', Uuml: '\u00dc',
  ntilde: '\u00f1', Ntilde: '\u00d1', ccedil: '\u00e7', Ccedil: '\u00c7',
  times: '\u00d7', divide: '\u00f7', deg: '\u00b0', plusmn: '\u00b1',
});

const WINDOWS_1252 = new Map([
  [0x80, 0x20ac], [0x82, 0x201a], [0x83, 0x0192], [0x84, 0x201e], [0x85, 0x2026], [0x86, 0x2020], [0x87, 0x2021],
  [0x88, 0x02c6], [0x89, 0x2030], [0x8a, 0x0160], [0x8b, 0x2039], [0x8c, 0x0152], [0x8e, 0x017d],
  [0x91, 0x2018], [0x92, 0x2019], [0x93, 0x201c], [0x94, 0x201d], [0x95, 0x2022], [0x96, 0x2013], [0x97, 0x2014],
  [0x98, 0x02dc], [0x99, 0x2122], [0x9a, 0x0161], [0x9b, 0x203a], [0x9c, 0x0153], [0x9e, 0x017e], [0x9f, 0x0178],
]);

const isControl = (cp) => cp <= 0x08 || (cp >= 0x0b && cp <= 0x1f) || (cp >= 0x7f && cp <= 0x9f);
const isTag = (cp) => cp >= 0xe0000 && cp <= 0xe007f;
const isSubdivisionTag = (cp) => (cp >= 0xe0030 && cp <= 0xe0039) || (cp >= 0xe0061 && cp <= 0xe007a);
const BLACK_FLAG = 0x1f3f4;
const CANCEL_TAG = 0xe007f;
const isHidden = (cp) =>
  cp === 0x061c || (cp >= 0x200b && cp <= 0x200c) || cp === 0x200e || cp === 0x200f || cp === 0x2028 || cp === 0x2029 ||
  (cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2060 && cp <= 0x206f) || cp === 0xfeff;

function tagMask(chars) {
  const keep = new Set();
  for (let i = 0; i < chars.length; i++) {
    if (chars[i].codePointAt(0) !== BLACK_FLAG) continue;
    let end = i + 1;
    while (end < chars.length && isSubdivisionTag(chars[end].codePointAt(0))) end++;
    const count = end - i - 1;
    if (count >= 1 && count <= 8 && chars[end]?.codePointAt(0) === CANCEL_TAG) {
      for (let at = i + 1; at <= end; at++) keep.add(at);
    }
  }
  return keep;
}

function isEmoji(ch) {
  return /\p{Extended_Pictographic}/u.test(ch);
}

function cleanText(value, max) {
  const chars = [...String(value ?? '')];
  const keptTags = tagMask(chars);
  let output = '';
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    const cp = ch.codePointAt(0);
    if (isControl(cp) || isHidden(cp) || (isTag(cp) && !keptTags.has(i))) continue;
    if (cp === 0x200d) {
      let before = i - 1;
      while (before >= 0 && (chars[before].codePointAt(0) >= 0x1f3fb && chars[before].codePointAt(0) <= 0x1f3ff || chars[before].codePointAt(0) === 0xfe0f)) before--;
      if (before < 0 || i === chars.length - 1 || !isEmoji(chars[before]) || !isEmoji(chars[i + 1])) continue;
    }
    output += ch;
  }
  const collapsed = output.replace(/\s+/gu, ' ').trim();
  const result = [...collapsed];
  if (result.length <= max) return collapsed;
  return `${result.slice(0, Math.max(0, max - 1)).join('')}…`;
}

/** Decode common named references and decimal/hex numeric character references. */
export function decodeHtmlEntities(value) {
  return String(value).replace(/&(#(?:[xX][\da-fA-F]+|\d+)|[A-Za-z][A-Za-z\d]+);?/g, (whole, entity) => {
    if (entity[0] !== '#') return Object.hasOwn(NAMED_ENTITIES, entity) ? NAMED_ENTITIES[entity] : whole;
    const hex = entity[1]?.toLowerCase() === 'x';
    const numeric = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
    if (!Number.isFinite(numeric) || numeric === 0 || numeric > 0x10ffff || (numeric >= 0xd800 && numeric <= 0xdfff)) return '\ufffd';
    return String.fromCodePoint(WINDOWS_1252.get(numeric) ?? numeric);
  });
}

function tagEnd(html, start) {
  let quote = '';
  for (let i = start; i < html.length; i++) {
    const char = html[i];
    if (quote) {
      if (char === quote) quote = '';
    } else if (char === '"' || char === "'") quote = char;
    else if (char === '>') return i + 1;
  }
  return -1;
}

const RAW_TEXT_TAGS = new Set(['script', 'style', 'title', 'textarea', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript']);

function rawTextClose(html, start, name) {
  const pattern = `</${name}`;
  for (let i = start; i < html.length; i++) {
    if (html[i] !== '<') continue;
    let matches = true;
    for (let j = 0; j < pattern.length; j++) {
      let code = html.charCodeAt(i + j);
      if (code >= 0x41 && code <= 0x5a) code += 0x20;
      if (code !== pattern.charCodeAt(j)) {
        matches = false;
        break;
      }
    }
    const delimiter = html[i + pattern.length];
    const isSpace = delimiter === '\t' || delimiter === '\n' || delimiter === '\f' || delimiter === '\r' || delimiter === ' ';
    if (matches && (delimiter === '>' || delimiter === '/' || isSpace)) return i;
  }
  return -1;
}

function attributes(raw, from) {
  const result = new Map();
  let i = from;
  while (i < raw.length) {
    while (i < raw.length && /[\s/]/.test(raw[i])) i++;
    if (i >= raw.length || raw[i] === '>') break;
    const start = i;
    while (i < raw.length && !/[\s=/>]/.test(raw[i])) i++;
    if (i === start) { i++; continue; }
    const name = raw.slice(start, i).toLowerCase();
    while (i < raw.length && /\s/.test(raw[i])) i++;
    let value = '';
    if (raw[i] === '=') {
      i++;
      while (i < raw.length && /\s/.test(raw[i])) i++;
      if (raw[i] === '"' || raw[i] === "'") {
        const quote = raw[i++];
        const valueStart = i;
        while (i < raw.length && raw[i] !== quote) i++;
        value = raw.slice(valueStart, i);
        if (raw[i] === quote) i++;
      } else {
        const valueStart = i;
        while (i < raw.length && !/[\s>]/.test(raw[i])) i++;
        value = raw.slice(valueStart, i);
      }
    }
    if (!result.has(name)) result.set(name, decodeHtmlEntities(value));
  }
  return result;
}

function scanTags(html) {
  const tags = [];
  let i = 0;
  let rawTextName = null;
  while (i < html.length) {
    if (rawTextName) {
      i = rawTextClose(html, i, rawTextName);
      if (i < 0) break;
      rawTextName = null;
    }
    const start = html.indexOf('<', i);
    if (start < 0) break;
    if (html.startsWith('<![CDATA[', start)) {
      const cdataEnd = html.indexOf(']]>', start + 9);
      i = cdataEnd < 0 ? html.length : cdataEnd + 3;
      continue;
    }
    if (html.startsWith('<!--', start)) {
      const commentEnd = html.indexOf('-->', start + 4);
      i = commentEnd < 0 ? html.length : commentEnd + 3;
      continue;
    }
    const end = tagEnd(html, start + 1);
    if (end < 0) break;
    let cursor = start + 1;
    let closing = false;
    if (html[cursor] === '/') { closing = true; cursor++; }
    while (cursor < end && /\s/.test(html[cursor])) cursor++;
    const nameStart = cursor;
    while (cursor < end && /[A-Za-z0-9:-]/.test(html[cursor])) cursor++;
    if (cursor === nameStart) { i = end; continue; }
    tags.push({
      name: html.slice(nameStart, cursor).toLowerCase(),
      closing,
      start,
      end,
      raw: html.slice(start, end),
      attrs: closing ? new Map() : attributes(html.slice(start, end), cursor - start),
    });
    if (!closing && RAW_TEXT_TAGS.has(tags[tags.length - 1].name)) rawTextName = tags[tags.length - 1].name;
    i = end;
  }
  return tags;
}

function metaCharset(html) {
  const tags = scanTags(html.slice(0, 8192));
  for (const tag of tags) {
    if (tag.name !== 'meta' || tag.closing) continue;
    const direct = tag.attrs.get('charset');
    if (direct) return direct.trim();
    const equiv = tag.attrs.get('http-equiv')?.toLowerCase();
    const content = tag.attrs.get('content') ?? '';
    if (equiv === 'content-type') {
      const match = content.match(/charset\s*=\s*["']?([^;"'\s]+)/i);
      if (match) return match[1];
    }
  }
  return null;
}

function htmlString(input, headerCharset) {
  if (typeof input === 'string') return input;
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input ?? []);
  let label = headerCharset || metaCharset(bytes.subarray(0, 8192).toString('latin1')) || 'utf-8';
  try {
    return new TextDecoder(label, { fatal: false }).decode(bytes);
  } catch {
    label = 'utf-8';
    return new TextDecoder(label, { fatal: false }).decode(bytes);
  }
}

function headTags(html) {
  const tags = scanTags(html);
  const open = tags.find((tag) => tag.name === 'head' && !tag.closing);
  const close = tags.find((tag) => tag.name === 'head' && tag.closing && (!open || tag.start >= open.end));
  if (!open) {
    const body = tags.find((tag) => tag.name === 'body' && !tag.closing);
    return tags.filter((tag) => tag.name !== 'head' && (!body || tag.start < body.start));
  }
  const end = close?.start ?? html.length;
  return tags.filter((tag) => tag.start >= open.end && tag.end <= end);
}

function titleText(html, tags) {
  const open = tags.find((tag) => tag.name === 'title' && !tag.closing);
  if (!open) return null;
  const close = tags.find((tag) => tag.name === 'title' && tag.closing && tag.start >= open.end);
  const end = close?.start ?? html.length;
  const raw = titleTextWithoutMarkup(html, open.end, end);
  return cleanText(decodeHtmlEntities(raw), 300) || null;
}

/** Remove comments and tag-shaped text with one forward pass, including malformed unclosed tails. */
function titleTextWithoutMarkup(html, start, end) {
  const parts = [];
  let textStart = start;
  let i = start;
  while (i < end) {
    if (html[i] !== '<') {
      i++;
      continue;
    }
    if (html.startsWith('<!--', i)) {
      const commentEnd = html.indexOf('-->', i + 4);
      parts.push(html.slice(textStart, i), ' ');
      if (commentEnd < 0 || commentEnd + 3 > end) return parts.join('');
      i = commentEnd + 3;
      textStart = i;
      continue;
    }
    const tagEndIndex = html.indexOf('>', i + 1);
    if (tagEndIndex < 0 || tagEndIndex >= end) break;
    parts.push(html.slice(textStart, i), ' ');
    i = tagEndIndex + 1;
    textStart = i;
  }
  parts.push(html.slice(textStart, end));
  return parts.join('');
}

function safeResolvedUrl(value, base) {
  if (!value) return null;
  try {
    const url = new URL(value.trim(), base);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

function baseFor(tags, finalUrl) {
  const tag = tags.find((item) => item.name === 'base' && !item.closing && item.attrs.has('href'));
  return safeResolvedUrl(tag?.attrs.get('href'), finalUrl) ?? finalUrl;
}

function sizeRank(sizes, rel) {
  if (!sizes) return rel.includes('apple-touch-icon') ? 180 : 0;
  let best = -1;
  for (const token of sizes.toLowerCase().split(/\s+/)) {
    if (token === 'any') best = Math.max(best, 256);
    const match = /^(\d+)x(\d+)$/.exec(token);
    if (!match) continue;
    const width = Number(match[1]);
    const height = Number(match[2]);
    if (width > 0 && height > 0 && width <= 256 && height <= 256) best = Math.max(best, width, height);
  }
  return best;
}

function iconCandidates(tags, baseUrl) {
  const candidates = [];
  for (const tag of tags) {
    if (tag.name !== 'link' || tag.closing) continue;
    const rel = (tag.attrs.get('rel') ?? '').toLowerCase().split(/\s+/).filter(Boolean);
    const isApple = rel.includes('apple-touch-icon') || rel.includes('apple-touch-icon-precomposed');
    if (!rel.includes('icon') && !isApple) continue;
    const type = (tag.attrs.get('type') ?? '').toLowerCase().split(';')[0].trim();
    if (type === 'image/svg+xml' || type === 'image/x-icon' || type === 'image/vnd.microsoft.icon') continue;
    const rank = sizeRank(tag.attrs.get('sizes'), isApple ? ['apple-touch-icon'] : rel);
    if (rank < 0) continue;
    const href = safeResolvedUrl(tag.attrs.get('href'), baseUrl);
    if (href) candidates.push({ href, rank });
  }
  candidates.sort((a, b) => b.rank - a.rank);
  return candidates;
}

function finalHost(finalUrl) {
  try {
    return new URL(finalUrl).hostname.replace(/^www\./i, '');
  } catch {
    return '';
  }
}

/** Parse title, descriptions, site name and safe image/icon URLs from the HTML head. */
/** @param {string | Uint8Array} input @param {{ finalUrl?: string, charset?: string | null }} [options] */
export function parseLinkHead(input, { finalUrl = '', charset = null } = {}) {
  const html = htmlString(input, charset);
  const tags = headTags(html);
  const values = new Map();
  for (const tag of tags) {
    if (tag.name !== 'meta' || tag.closing) continue;
    const key = (tag.attrs.get('property') ?? tag.attrs.get('name') ?? '').trim().toLowerCase();
    const value = tag.attrs.get('content');
    if (!key || value === undefined || !value.trim() || values.has(key)) continue;
    values.set(key, value);
  }
  const baseUrl = baseFor(tags, finalUrl);
  const title = cleanText(values.get('og:title') ?? values.get('twitter:title') ?? titleText(html, tags), 300) || null;
  const description = cleanText(values.get('og:description') ?? values.get('twitter:description') ?? values.get('description'), 1000) || null;
  const siteName = cleanText(values.get('og:site_name') ?? finalHost(finalUrl), 100) || null;
  const imageUrl = [values.get('og:image'), values.get('og:image:secure_url'), values.get('twitter:image')]
    .map((candidate) => safeResolvedUrl(candidate, baseUrl)).find(Boolean) ?? null;
  const candidates = iconCandidates(tags, baseUrl);
  const iconUrl = candidates[0]?.href ?? safeResolvedUrl('/favicon.ico', baseUrl);
  return { title, description, siteName, imageUrl, iconUrl, baseUrl };
}
