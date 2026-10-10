// The SVG policy for icon and sticker bodies (TAB-82, TAB-204), shared by the server and the app. Icons and stickers
// carry their SVG inline in `body`. Nothing that runs or that loads from outside the body gets through: the elements are
// an allow-list, and every attribute is checked (event handlers, links that are not `#id` or an inline raster image,
// url() that is not `#id`, CSS image functions, script and data addresses). An exported SVG or PNG and an opened .drift
// file have no Content Security Policy, so the body itself has to be safe.
//
// One scan, two uses:
// - `svgProblem` (templates on the server) refuses a body with any problem, and refuses animations too;
// - `sanitizeSvg` (the app: icons, stickers, boards from collaborators and files) drops the elements and attributes the
//   policy refuses and keeps everything else exactly as it was. Markup the scan cannot read as plain tags is refused as a
//   whole (an empty body), since a browser might read it differently.
// It reads the text, not a DOM, so the server, the tests and the browser give the same answer.

export const MAX_SVG_BODY = 100_000;

const SVG_ELEMENTS = new Set([
  'svg', 'g', 'defs', 'symbol', 'use', 'path', 'circle', 'ellipse', 'rect', 'line', 'polyline', 'polygon', 'image',
  'text', 'tspan', 'title', 'desc', 'marker', 'pattern', 'clipPath', 'mask', 'linearGradient', 'radialGradient', 'stop',
  'filter', 'feBlend', 'feColorMatrix', 'feComponentTransfer', 'feComposite', 'feConvolveMatrix', 'feDiffuseLighting',
  'feDisplacementMap', 'feDistantLight', 'feDropShadow', 'feFlood', 'feFuncA', 'feFuncB', 'feFuncG', 'feFuncR',
  'feGaussianBlur', 'feImage', 'feMerge', 'feMergeNode', 'feMorphology', 'feOffset', 'fePointLight',
  'feSpecularLighting', 'feSpotLight', 'feTile', 'feTurbulence',
]);
// Animated icons (spinners and the like, about 1,800 of the Iconify sets) animate drawing attributes only. An animation
// may change nothing that is a link or a style: `attributeName` must be one of these, and its values pass the same checks
// as any attribute. `animateMotion` has no attributeName; its `mpath` may point at `#id` only.
const ANIMATIONS = new Set(['animate', 'animateTransform', 'animateMotion', 'set', 'mpath']);
const ANIMATABLE = new Set([
  'd', 'opacity', 'fill-opacity', 'stroke-opacity', 'stroke-width', 'stroke-dashoffset', 'stroke-dasharray', 'r', 'rx', 'ry',
  'cx', 'cy', 'x', 'y', 'width', 'height', 'transform', 'fill', 'stroke', 'offset', 'points', 'x1', 'x2', 'y1', 'y2',
]);
const SVG_NS = 'http://www.w3.org/2000/svg';
const XLINK_NS = 'http://www.w3.org/1999/xlink';
// Inside a tag only the whitespace both the HTML and the XML parser skip ([\t\n\r ]; form feed is refused as a control
// character). `\s` would also take U+00A0 and the other Unicode spaces, which a browser reads as the start of an unquoted
// value: `title=\u00a0"x onclick=alert(1) y"` is one quoted attribute to `\s` and an onclick to the browser.
const TAG_RE = /<(\/?)([A-Za-z][A-Za-z0-9]*)((?:[\t\n\r ]+[A-Za-z_:][A-Za-z0-9_:.-]*(?:[\t\n\r ]*=[\t\n\r ]*(?:"[^"<>]*"|'[^'<>]*'))?)*)[\t\n\r ]*(\/?)>/y;
const ATTR_RE = /[\t\n\r ]+([A-Za-z_:][A-Za-z0-9_:.-]*)(?:[\t\n\r ]*=[\t\n\r ]*(?:"([^"]*)"|'([^']*)'))?/g;
// Character classes by code point, not by regular expression (as in board-ops.mjs).
const isSvgControl = (cp) => cp <= 0x08 || cp === 0x0b || cp === 0x0c || (cp >= 0x0e && cp <= 0x1f) || (cp >= 0x7f && cp <= 0x9f) || cp === 0x2028 || cp === 0x2029;
// whitespace, control and invisible characters a browser ignores inside a URL scheme
const isUrlNoise = (cp) =>
  cp <= 0x20 || (cp >= 0x7f && cp <= 0xa0) || cp === 0x1680 || cp === 0x180e || (cp >= 0x2000 && cp <= 0x200f) ||
  (cp >= 0x2028 && cp <= 0x202f) || (cp >= 0x205f && cp <= 0x206f) || cp === 0x3000 || cp === 0xfeff;
const without = (value, drop) => {
  let out = '';
  for (const ch of value) if (!drop(ch.codePointAt(0))) out += ch;
  return out;
};
const RASTER_DATA_RE = /^data:image\/(png|jpeg|gif|webp)[;,]/;
// Inside SVG title/desc the HTML parser reads <image> as <img>, where srcset can load outside the body.
const BLOCKED_ATTRIBUTES = new Set(['xml:base', 'srcdoc', 'srcset', 'formaction', 'action', 'poster', 'ping']);

const decodeBasic = (v) => v.replace(/&(amp|lt|gt|quot|apos);/g, (_m, name) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[name]);

/** Why one attribute is refused, or null. */
function attributeProblem(element, name, rawValue) {
  const lname = name.toLowerCase();
  if (lname.startsWith('on')) return `has an event handler (${name.slice(0, 30)})`;
  if (BLOCKED_ATTRIBUTES.has(lname)) return `has the ${name.slice(0, 30)} attribute`;
  const value = decodeBasic(rawValue);
  if (value.includes('\\')) return 'has a backslash in an attribute';
  const flat = without(value, isUrlNoise).toLowerCase();
  if (lname === 'xmlns' || lname.startsWith('xmlns:')) {
    return value === SVG_NS || value === XLINK_NS ? null : 'declares a namespace other than SVG';
  }
  const local = lname.slice(lname.lastIndexOf(':') + 1);
  if (local === 'href' || local === 'src') {
    if (flat.startsWith('#')) return null;
    if (element !== 'use' && element !== 'mpath' && RASTER_DATA_RE.test(flat)) return null;
    return element === 'use' || element === 'mpath'
      ? `has a <${element}> that points outside the icon`
      : 'has a link that is not a reference inside the icon or an inline png, jpeg, gif or webp image';
  }
  if (flat.includes('javascript:') || flat.includes('vbscript:') || flat.includes('data:')) return 'has a script or data address in an attribute';
  if (lname === 'style' && /@import|expression|behavior|binding/.test(flat)) return 'has a style that loads or runs something';
  // mask, cursor and the like take CSS images, which can name an address without url()
  if (/(image-set|image|cross-fade|element|paint|src)\(/.test(flat)) return 'has a CSS image function that could load something from outside';
  for (const m of flat.matchAll(/url\(([^)]*)(\)|$)/g)) {
    // CSS accepts the end of an attribute as the end of an unclosed url(), so it must not escape this check.
    if (!m[2]) return 'has a url() that is not closed';
    if (!m[1].replace(/^['"]/, '').startsWith('#')) return 'has a url() that points outside the icon';
  }
  if (local === 'attributename' && !ANIMATABLE.has(flat)) return `animates ${value.slice(0, 30)}, which an icon may not change`;
  return null;
}

/**
 * Reads a body tag by tag. Returns `fatal` for markup it cannot read as plain tags (nothing of it can be kept), else the
 * body with every refused element (and what is inside it) and every refused attribute left out, and the reasons.
 * @param {unknown} body
 * @param {{ maxLength?: number, animations?: boolean }} [options]
 * @returns {{ fatal: string | null, problems: string[], body: string }}
 */
export function scanSvg(body, { maxLength = MAX_SVG_BODY, animations = false } = {}) {
  const fatal = (why) => ({ fatal: why, problems: [why], body: '' });
  if (typeof body !== 'string') return fatal('is not text');
  if (body.length > maxLength) return fatal(`is longer than ${maxLength.toLocaleString('en-US')} characters`);
  for (const ch of body) if (isSvgControl(ch.codePointAt(0))) return fatal('has control characters');
  if (/<[!?]/.test(body)) return fatal('has a comment, CDATA section, DOCTYPE or processing instruction');
  if (/&#/.test(body) || /&(?!(?:amp|lt|gt|quot|apos);)/.test(body)) return fatal('has character references other than &amp; &lt; &gt; &quot; and &apos;');
  const problems = [];
  const stack = [];
  let dropping = 0; // how many open elements, from the outermost refused one inwards, are being left out
  let out = '';
  let at = 0;
  while (at < body.length) {
    const lt = body.indexOf('<', at);
    const between = body.slice(at, lt === -1 ? body.length : lt);
    if (between.includes('>')) return fatal('has a stray ">"');
    if (!dropping) out += between;
    if (lt === -1) break;
    TAG_RE.lastIndex = lt;
    const tag = TAG_RE.exec(body);
    if (!tag) return fatal('has markup that is not a plain SVG tag');
    at = TAG_RE.lastIndex;
    const [raw, closing, element, attributes, selfClosing] = tag;
    if (closing) {
      if (attributes.trim() || selfClosing || stack.pop() !== element) return fatal('has tags that do not match');
      if (dropping) dropping--;
      else out += raw;
      continue;
    }

    let why = null;
    if (!SVG_ELEMENTS.has(element) && !(animations && ANIMATIONS.has(element))) why = `uses <${element.slice(0, 30)}>, which an icon cannot contain`;
    const kept = [];
    let changed = false;
    const seen = new Set();
    for (const attr of attributes.matchAll(ATTR_RE)) {
      const key = attr[1].toLowerCase();
      if (seen.has(key)) return fatal(`repeats the ${attr[1].slice(0, 30)} attribute`);
      seen.add(key);
      const problem = attributeProblem(element, attr[1], attr[2] ?? attr[3] ?? '');
      if (problem === null) {
        kept.push(attr[0]);
        continue;
      }
      problems.push(problem);
      changed = true;
      // an animation of something it may not change goes as a whole, rather than animating a default attribute
      if (key === 'attributename') why ??= problem;
    }
    if (why) problems.push(why);
    if (!selfClosing) stack.push(element);
    if (dropping || why) {
      if (!selfClosing) dropping++;
      continue;
    }
    out += changed ? `<${element}${kept.join('')}${selfClosing ? '/' : ''}>` : raw;
  }
  if (stack.length) return fatal('has a tag that is not closed');
  return { fatal: null, problems, body: out };
}

/** Why a body is refused (templates: any problem, animations included), or null when it is plain drawing. */
export function svgProblem(body) {
  return scanSvg(body).problems[0] ?? null;
}

/**
 * The body with everything the policy refuses left out (the app's icons and stickers). Animations of drawing attributes
 * stay. A body the scan cannot read, or one over `maxLength`, comes back empty.
 */
export function sanitizeSvg(body, { maxLength = 2_000_000 } = {}) {
  return scanSvg(body, { maxLength, animations: true }).body;
}
