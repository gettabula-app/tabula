import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const FONT = 'src/assets/fonts/newsreader/newsreader-latin-wght-normal.woff2';
const OFL = 'src/assets/fonts/newsreader/OFL.txt';

function cssFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return cssFiles(path);
    return entry.name.endsWith('.css') ? [path] : [];
  });
}

function urlValue(value: string): string {
  return value.trim().replace(/^(['"])(.*)\1$/, '$2');
}

function isRelativeOrData(value: string): boolean {
  return /^data:/i.test(value) || (!/^[a-z][a-z\d+.-]*:/i.test(value) && !value.startsWith('/'));
}

describe('font sources', () => {
  it('uses only relative or data URLs and local font sources in CSS font faces and url() references', () => {
    const violations: string[] = [];
    for (const file of cssFiles(join(ROOT, 'src'))) {
      const css = readFileSync(file, 'utf8');
      const rel = file.slice(ROOT.length + 1).replaceAll('\\', '/');
      for (const match of css.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/gi)) {
        const value = urlValue(match[2]);
        if (!isRelativeOrData(value)) violations.push(`${rel}: url(${value})`);
      }
      for (const face of css.matchAll(/@font-face\s*\{([^}]*)\}/gi)) {
        const declarations = [...face[1].matchAll(/\bsrc\s*:\s*([^;]+);?/gi)].map((match) => match[1]);
        if (declarations.length === 0) {
          violations.push(`${rel}: @font-face without src`);
          continue;
        }
        for (const src of declarations) {
          const sources = [...src.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/gi)].map((match) => urlValue(match[2]));
        const hasLocalSource = /\blocal\(\s*(['"])[^'"]+\1\s*\)/i.test(src);
        if ((sources.length === 0 && !hasLocalSource) || sources.some((value) => !isRelativeOrData(value))) {
            violations.push(`${rel}: @font-face src ${src.trim()}`);
          }
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('ships Newsreader with its OFL and keeps the Latin subset under 80 KB', () => {
    const fontPath = join(ROOT, FONT);
    const oflPath = join(ROOT, OFL);
    const fontExists = existsSync(fontPath);
    const oflExists = existsSync(oflPath);
    expect(fontExists).toBe(true);
    expect(oflExists).toBe(true);
    if (!fontExists || !oflExists) return;
    expect(statSync(fontPath).isFile()).toBe(true);
    expect(statSync(oflPath).isFile()).toBe(true);
    expect(statSync(fontPath).size).toBeLessThan(80 * 1024);
    expect(readFileSync(join(ROOT, 'src/styles.css'), 'utf8')).toContain(`url('./assets/fonts/newsreader/newsreader-latin-wght-normal.woff2')`);
  });
});
