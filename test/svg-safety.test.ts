import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { sanitizeSvg, scanSvg, svgProblem } from '../shared/svg-safety.mjs';
import { sanitizeSvgBody } from '../src/markup';
import { CLEAN_SVG, HOSTILE_SVG } from './svg-payloads';

// TAB-204: the app's icon and sticker sanitizer and the server's template check share one policy (shared/svg-safety.mjs).
// The app leaves out what the policy refuses; nothing that runs or loads from outside the body may survive, because an
// exported SVG or PNG and an opened .drift file have no Content Security Policy. Real Iconify bodies come through untouched.

/** Nothing in a cleaned body may run or reach outside it. */
function harmless(out: string) {
  expect(scanSvg(out, { animations: true, maxLength: 10_000_000 }).problems).toEqual([]);
  expect(out).not.toMatch(/<\s*(script|foreignObject|iframe|object|embed|style|a)\b/i);
  expect(out).not.toMatch(/\son[a-z]+\s*=/i);
  expect(out).not.toMatch(/javascript:|vbscript:|https?:|\/\/evil/i);
  for (const m of out.matchAll(/url\(([^)]*)\)/gi)) expect(m[1].replace(/^['"]|&quot;/g, '')).toMatch(/^#/);
}

describe('sanitizeSvg', () => {
  it.each(HOSTILE_SVG)('leaves nothing harmful of %s', (_name, body) => {
    const out = sanitizeSvg(body);
    harmless(out);
    // cleaning twice changes nothing more
    expect(sanitizeSvg(out)).toBe(out);
  });

  it.each(CLEAN_SVG.map((b) => [b]))('keeps plain drawing exactly: %s', (body) => {
    expect(sanitizeSvg(body)).toBe(body);
  });

  const remote: [string, string, string][] = [
    ['an http <image>', '<image href="https://evil.example/p.png" width="1" height="1"/>', '<image width="1" height="1"/>'],
    ['an xlink <image>', '<image xlink:href="http://evil.example/p.png" width="1"/>', '<image width="1"/>'],
    ['a protocol-relative <image>', '<image href="//evil.example/p.png"/>', '<image/>'],
    ['an <image> with an svg data address', '<image href="data:image/svg+xml;base64,PHN2Zy8+"/>', '<image/>'],
    ['an <feImage>', '<filter id="f"><feImage href="https://evil.example/t.png"/></filter>', '<filter id="f"><feImage/></filter>'],
    ['a url() in a style attribute', '<path style="fill:url(https://evil.example/x.svg#a)" d="M0 0"/>', '<path d="M0 0"/>'],
    ['a url() in a paint attribute', '<path fill="url(//evil.example/x#a)" d="M0 0"/>', '<path d="M0 0"/>'],
    ['a <style> element', '<style>path{fill:url(https://evil.example/x)}</style><path d="M0 0"/>', '<path d="M0 0"/>'],
    ['a <use> of another file', '<use href="https://evil.example/s.svg#a"/>', '<use/>'],
    ['an animation that sets a link', '<use href="#a"><set attributeName="href" to="https://evil.example/x#a"/></use>', '<use href="#a"></use>'],
    ['an animation of xlink:href', '<animate attributeName="xlink:href" values="#a;javascript:alert(1)"/>', ''],
    ['an animation of a style', '<animate attributeName="style" to="fill:url(https://evil.example/x)"/>', ''],
    ['an animated paint that loads', '<path d="M0 0"><animate attributeName="fill" values="red;url(https://evil.example/x)"/></path>', '<path d="M0 0"><animate attributeName="fill"/></path>'],
    ['an <mpath> to another file', '<animateMotion dur="1s"><mpath href="https://evil.example/p#a"/></animateMotion>', '<animateMotion dur="1s"><mpath/></animateMotion>'],
    ['an <a> around drawing', '<a href="https://evil.example"><path d="M0 0"/></a><circle r="1"/>', '<circle r="1"/>'],
  ];
  it.each(remote)('takes out %s', (_name, body, expected) => {
    expect(sanitizeSvg(body)).toBe(expected);
    harmless(sanitizeSvg(body));
  });

  it('keeps animations of drawing attributes, which templates still refuse', () => {
    const spinner = '<path d="M12 2a10 10 0 0 1 10 10"><animateTransform attributeName="transform" type="rotate" dur="0.75s" values="0 12 12;360 12 12" repeatCount="indefinite"/></path><circle r="2"><animate attributeName="opacity" values="1;0;1" dur="1s"/><set attributeName="fill-opacity" to="0.5" begin="1s"/></circle>';
    expect(sanitizeSvg(spinner)).toBe(spinner);
    expect(svgProblem(spinner)).toMatch(/animateTransform/);
  });

  it('refuses as a whole markup it cannot read, and the app gets an empty body', () => {
    for (const body of ['<g><path d="M0 0"/>', '<!-- x --><path/>', '<path d=M0/>', '<text>&#60;</text>']) expect(sanitizeSvgBody(body)).toBe('');
  });
});

describe('real Iconify bodies', () => {
  const dir = path.join(fileURLToPath(new URL('..', import.meta.url)), 'node_modules/@iconify/json/json');
  const sample: [string, string][] = [];
  for (const file of fs.readdirSync(dir).sort()) {
    const set = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')) as { prefix: string; icons?: Record<string, { body: string }> };
    Object.entries(set.icons ?? {}).forEach(([name, icon], i) => {
      // every animated icon, and every 40th of the rest
      if (icon.body.includes('<animate') || icon.body.includes('<set') || i % 40 === 0) sample.push([`${set.prefix}:${name}`, icon.body]);
    });
  }

  it(`come through the app's sanitizer unchanged (${sample.length} bodies, animated ones included)`, () => {
    expect(sample.length).toBeGreaterThan(5000);
    const changed = sample.filter(([, body]) => sanitizeSvg(body) !== body);
    // Five meteocons icons animate an attribute named like an id ("meteoconsSunHotFill2": the set's id prefixing renamed
    // their attributeName="d"), which a browser ignores; leaving those animations out changes nothing that is drawn.
    for (const [id, body] of changed) {
      expect(id).toMatch(/^meteocons:/);
      expect(scanSvg(body, { animations: true, maxLength: 10_000_000 }).problems.every((p) => p.startsWith('animates meteocons'))).toBe(true);
    }
    expect(changed.length).toBeLessThanOrEqual(5);
  });
});
