import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// The screenshots of the README and the user guide (docs/visual-check.md, "Docs images"): every image a page shows exists, has
// words for a screen reader, stays small, and every image the script makes is in docs/images (so a rename cannot break a link).

const root = path.resolve(import.meta.dirname, '..');
const guide = path.join(root, 'docs', 'guide');
const pages = [
  ...fs.readdirSync(guide).filter((f) => f.endsWith('.md')).map((f) => path.join(guide, f)),
  path.join(root, 'README.md'),
];
const MAX_BYTES = 400 * 1024;

const refs = pages.flatMap((page) => {
  const text = fs.readFileSync(page, 'utf8');
  return [...text.matchAll(/!\[([^\]]*)\]\(([^)\s]+\.(?:png|webp|jpg))\)/g)].map((m) => ({
    // the guide serves docs/images as its own images/ folder
    page: path.relative(root, page), alt: m[1], file: path.resolve(path.dirname(page), m[2].replace(/^images\//, page.startsWith(guide) ? '../images/' : 'images/')),
  }));
});

describe('guide and README images', () => {
  it('finds the images the pages show', () => {
    expect(refs.length).toBeGreaterThan(15);
  });

  it('points every image at a file that exists in docs/images', () => {
    for (const r of refs) {
      expect(fs.existsSync(r.file), `${r.page}: ${path.relative(root, r.file)}`).toBe(true);
      expect(path.dirname(r.file)).toBe(path.join(root, 'docs', 'images'));
    }
  });

  it('gives every image alt text that says what it shows', () => {
    for (const r of refs) {
      expect(r.alt.trim().length, `${r.page}: ${path.basename(r.file)}`).toBeGreaterThanOrEqual(10);
      expect(r.alt, `${r.page}: ${path.basename(r.file)}`).not.toMatch(/earlier|old layout|screenshot of/i);
    }
  });

  it('keeps each image under 400 KB', () => {
    for (const r of refs) expect(fs.statSync(r.file).size, path.basename(r.file)).toBeLessThanOrEqual(MAX_BYTES);
  });

  it('has a file in docs/images for every image the script writes, and a PNG header on each', () => {
    const script = fs.readFileSync(path.join(root, 'scripts', 'docs-images.mjs'), 'utf8');
    const names = [...script.matchAll(/save\(page, '([\w-]+)'/g)].map((m) => m[1]);
    expect(names).toEqual(expect.arrayContaining(['chat-tray', 'chat-page', 'layers-panel']));
    for (const name of names) {
      const file = path.join(root, 'docs', 'images', `${name}.png`);
      expect(fs.existsSync(file), name).toBe(true);
      expect([...fs.readFileSync(file).subarray(1, 4)].map((c) => String.fromCharCode(c)).join(''), name).toBe('PNG');
    }
  });

  it('shows the dock and the Chat page in the chat guide', () => {
    const chat = fs.readFileSync(path.join(guide, 'chat.md'), 'utf8');
    expect(chat).toContain('images/chat-tray.png');
    expect(chat).toContain('images/chat-page.png');
  });
});
