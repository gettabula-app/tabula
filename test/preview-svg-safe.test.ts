import { describe, expect, it } from 'vitest';
import {
  PICTURE_ATTRIBUTES, PICTURE_ELEMENTS, PICTURE_FONT_STACK, SvgSyntaxError, parseSvgSubset, sanitizePictureSvg, whitelistProblems,
  type PictureFrame,
} from '../src/preview-svg-safe';

// The whitelist of a board picture (src/preview-svg-safe.ts). A picture is drawn from an SVG string, so each test below sanitises a hostile
// source and then reads the result back with the same parser: only whitelisted elements, attributes and values may remain.

const frame: PictureFrame = { viewBox: [0, 0, 480, 300], width: 480, height: 300, background: '#FFFFFF' };
const clean = (body: string) => sanitizePictureSvg(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 300">${body}</svg>`, frame);
const names = (svg: string) => {
  const out: string[] = [];
  const walk = (el: ReturnType<typeof parseSvgSubset>) => {
    out.push(el.name);
    for (const c of el.children) if ('name' in c) walk(c);
  };
  walk(parseSvgSubset(svg));
  return out;
};

describe('the whitelist of a board picture', () => {
  it('allows the listed elements and nothing else', () => {
    expect([...PICTURE_ELEMENTS].sort()).toEqual([
      'circle', 'clipPath', 'defs', 'ellipse', 'g', 'image', 'line', 'linearGradient', 'path', 'polygon', 'polyline', 'radialGradient', 'rect', 'stop', 'svg', 'text', 'tspan',
    ]);
  });

  it('a clean picture is already a picture the whitelist allows, and sanitising it again changes nothing', () => {
    const svg = clean('<rect x="10" y="10" width="100" height="60" rx="4" fill="#FFE16B" stroke="#18212B" stroke-width="1"/><text x="20" y="40" font-size="16">Hello</text>');
    expect(whitelistProblems(svg)).toEqual([]);
    // sanitising again keeps every drawn element (the picture has its own background rectangle, which is drawn once more)
    const again = sanitizePictureSvg(svg, frame);
    expect(again).toContain('<rect x="10" y="10" width="100" height="60" rx="4" fill="#FFE16B" stroke="#18212B" stroke-width="1"/><text x="20" y="40" font-size="16">Hello</text>');
    expect(whitelistProblems(again)).toEqual([]);
  });

  it('every text is drawn in the fixed system stack, whatever the source asked for', () => {
    const svg = clean('<text x="1" y="1" font-family="&quot;Cabinet Grotesk&quot;, serif">Font</text><tspan font-family="url(http://evil.example/f.woff2)">x</tspan>');
    expect(svg).not.toContain('Cabinet');
    expect(svg).not.toContain('evil');
    expect(svg).toContain(`font-family="${PICTURE_FONT_STACK.replace(/"/g, '&quot;')}"`);
    expect(whitelistProblems(svg)).toEqual([]);
  });

  it('drops script, foreignObject, style, use, anchors, animation, filters and titles with everything inside them', () => {
    const svg = clean([
      '<script>alert(1)</script>',
      '<foreignObject><div xmlns="http://www.w3.org/1999/xhtml">bad</div></foreignObject>',
      '<style>@import url(http://evil.example/a.css); rect { fill: url(http://evil.example/x) }</style>',
      '<use href="http://evil.example/sprite.svg#x"/>',
      '<a href="https://evil.example/"><rect width="5" height="5"/></a>',
      '<animate attributeName="x" to="0"/>',
      '<set attributeName="fill" to="red"/>',
      '<filter id="f"><feImage href="http://evil.example/p.png"/></filter>',
      '<title>tooltip text</title>',
      '<rect x="1" y="1" width="9" height="9" fill="#123456"/>',
    ].join(''));
    for (const bad of ['script', 'foreignObject', 'style', 'use', 'animate', 'set', 'filter', 'feImage', 'title', 'evil', 'alert', 'tooltip']) {
      expect(svg).not.toContain(bad);
    }
    expect(svg).toContain('fill="#123456"');
    expect(whitelistProblems(svg)).toEqual([]);
  });

  it('drops event handlers, style attributes that carry anything but a whitelisted declaration, and unknown attributes', () => {
    const svg = clean('<rect x="1" y="1" width="9" height="9" onclick="alert(1)" onload="x()" style="fill:url(http://evil.example/x);background:url(http://e/y)" data-x="1" fill="#abcdef"/>');
    expect(svg).not.toMatch(/onclick|onload|style|data-x|evil/);
    expect(svg).toContain('fill="#abcdef"');
    expect(whitelistProblems(svg)).toEqual([]);
  });

  it('reads the whitelisted declarations of a style attribute as attributes', () => {
    const svg = clean('<rect x="1" y="1" width="9" height="9" style="fill:#FFE16B;stroke:#18212B;stroke-opacity:0.4"/>');
    expect(svg).toContain('fill="#FFE16B"');
    expect(svg).toContain('stroke="#18212B"');
    expect(svg).toContain('stroke-opacity="0.4"');
  });

  it('keeps a local reference only when its target is in the picture, and drops the rest', () => {
    const svg = clean('<defs><linearGradient id="sheen"><stop offset="0" stop-color="#000" stop-opacity="0.1"/></linearGradient></defs>'
      + '<rect x="1" y="1" width="9" height="9" fill="url(#sheen)"/><rect x="1" y="1" width="9" height="9" fill="url(#missing)"/>'
      + '<rect x="1" y="1" width="9" height="9" fill="url(http://evil.example/p)"/>');
    expect(svg).toContain('fill="url(#sheen)"');
    expect(svg).not.toContain('missing');
    expect(svg).not.toContain('evil');
    expect(whitelistProblems(svg)).toEqual([]);
  });

  it('an image may carry only a data: picture of a bitmap type, never a link', () => {
    const png = 'data:image/png;base64,iVBORw0KGgo=';
    const kept = clean(`<image x="0" y="0" width="10" height="10" href="${png}" preserveAspectRatio="none"/>`);
    expect(kept).toContain(`href="${png}"`);
    for (const href of ['https://evil.example/p.png', '//evil.example/p.png', 'data:image/svg+xml;base64,PHN2Zy8+', 'data:text/html;base64,PGI+', 'javascript:alert(1)', '/api/boards/x/assets/y']) {
      const svg = clean(`<image x="0" y="0" width="10" height="10" href="${href}"/>`);
      expect(svg).not.toContain('href=');
      expect(svg).not.toContain('evil');
    }
  });

  it('colours are plain hex, none, transparent or a local reference; anything else is dropped', () => {
    const svg = clean('<rect x="1" y="1" width="9" height="9" fill="color-mix(in srgb, red 50%, blue)" stroke="red;background:url(x)" stop-color="x"/>'
      + '<rect x="1" y="1" width="9" height="9" fill="transparent" stroke="none"/>');
    expect(svg).not.toContain('color-mix');
    expect(svg).not.toContain('red');
    expect(svg).toContain('fill="transparent"');
    expect(svg).toContain('stroke="none"');
  });

  it('numbers and path data are checked: text in a number or path is dropped with its attribute', () => {
    const svg = clean('<rect x="1; drop table" y="1" width="9" height="9"/><path d="M0 0 L10 10 Z" /><path d="M0 0 javascript:alert(1)"/>');
    expect(svg).not.toContain('drop');
    expect(svg).toContain('d="M0 0 L10 10 Z"');
    expect(svg).not.toContain('javascript');
    expect(whitelistProblems(svg)).toEqual([]);
  });

  it('a text node is cut at the cap and loses control characters; markup in text is escaped, never read as markup', () => {
    const long = 'a'.repeat(5000);
    const svg = clean(`<text x="1" y="1">&lt;script&gt;alert(1)&lt;/script&gt;]]&gt;\u0001\u0007${long}</text>`);
    expect(svg).toContain('&lt;script&gt;alert(1)&lt;/script&gt;]]&gt;');
    expect(svg).not.toContain('\u0001');
    expect(svg).not.toContain('\u0007');
    expect(svg.length).toBeLessThan(1500);
    expect(whitelistProblems(svg)).toEqual([]);
  });

  it('right-to-left and mixed-script text survives as text', () => {
    const svg = clean('<text x="1" y="1">مرحبا بالعالم · שלום · 你好</text>');
    expect(svg).toContain('مرحبا بالعالم · שלום · 你好');
  });

  it('text outside text elements is dropped', () => {
    const svg = clean('<rect x="1" y="1" width="9" height="9">stray words</rect>');
    expect(svg).not.toContain('stray');
  });

  it('a stop belongs to a gradient only', () => {
    const svg = clean('<stop offset="0" stop-color="#000"/><g><stop offset="1" stop-color="#fff"/></g>');
    expect(svg).not.toContain('<stop');
  });

  it('a nested svg is dropped; the picture has one root', () => {
    const svg = clean('<svg x="0" y="0"><rect x="1" y="1" width="9" height="9"/></svg>');
    expect(names(svg).filter((n) => n === 'svg')).toHaveLength(1);
  });
});

describe('what the parser refuses (an error, so the caller draws the blocks instead)', () => {
  it.each([
    ['a comment', '<svg><!-- x --></svg>'],
    ['a DOCTYPE', '<!DOCTYPE svg><svg/>'],
    ['a processing instruction', '<?xml version="1.0"?><svg/>'],
    ['an entity beyond the five named ones', '<svg><text>&nbsp;</text></svg>'],
    ['a raw < inside an attribute', '<svg><rect width="1<2"/></svg>'],
    ['an unclosed element', '<svg><rect></svg>'],
    ['a mismatched closing tag', '<svg><g></rect></svg>'],
    ['an unquoted attribute', '<svg><rect width=1/></svg>'],
    ['a repeated attribute', '<svg><rect width="1" width="2"/></svg>'],
    ['two roots', '<svg/><svg/>'],
    ['not an svg root', '<html><body/></html>'],
    ['text around the root', 'hello<svg/>'],
  ])('refuses %s', (_label, source) => {
    expect(() => parseSvgSubset(source)).toThrow(SvgSyntaxError);
    expect(() => sanitizePictureSvg(source, frame)).toThrow(SvgSyntaxError);
  });
});

describe('the emitted picture, parsed back', () => {
  it('uses only listed elements and attributes, with values the whitelist accepts', () => {
    const svg = clean('<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#FFFFFF" stop-opacity="0.5"/></linearGradient>'
      + '<clipPath id="c"><rect x="0" y="0" width="5" height="5"/></clipPath></defs>'
      + '<g transform="translate(10 10)" clip-path="url(#c)"><circle cx="5" cy="5" r="2" fill="url(#g)" stroke-dasharray="4 2"/>'
      + '<ellipse cx="1" cy="1" rx="1" ry="2"/><line x1="0" y1="0" x2="9" y2="9" stroke-linecap="round"/>'
      + '<polygon points="0,0 9,0 4.5,9" fill-opacity="0.3"/><polyline points="0 0 1 1"/>'
      + '<image x="0" y="0" width="5" height="5" href="data:image/webp;base64,UklGRg==" preserveAspectRatio="xMidYMid slice"/></g>');
    const allowed = new Set<string>(PICTURE_ELEMENTS);
    const walk = (el: ReturnType<typeof parseSvgSubset>) => {
      expect(allowed.has(el.name)).toBe(true);
      const checks = PICTURE_ATTRIBUTES[el.name]!;
      const bad = el.attrs.filter(([key, value]) => !checks[key] || (key !== 'font-family' && checks[key]!(value) === null)).map(([key, value]) => `${el.name}/${key}=${value}`);
      expect(bad).toEqual([]);
      for (const c of el.children) if ('name' in c) walk(c);
    };
    walk(parseSvgSubset(svg));
    expect(whitelistProblems(svg)).toEqual([]);
  });

  it('whitelistProblems names what it finds in a picture that is not allowed', () => {
    const problems = whitelistProblems('<svg xmlns="http://www.w3.org/2000/svg"><script/><rect onclick="x" width="1" height="1"/></svg>');
    expect(problems).toEqual(expect.arrayContaining(['element script', 'attribute rect/onclick']));
  });
});
