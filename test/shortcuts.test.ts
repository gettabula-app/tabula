import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SHORTCUTS, TOOL_KEYS } from '../src/shortcuts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

// Keys the keydown listener in bindKeys handles, read from its source text.
function handledKeys(): Set<string> {
  const src = readFileSync(join(ROOT, 'src/app.ts'), 'utf8');
  const bind = src.indexOf('private bindKeys()');
  const start = src.indexOf("window.addEventListener('keydown'", bind);
  const end = src.indexOf("window.addEventListener('keyup'", start);
  expect(bind).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  let body = src.slice(start, end);
  const ids = new Set<string>();
  const zoomIn = "mod && (k === '=' || k === '+')";
  if (body.includes(zoomIn)) ids.add('mod+=');
  body = body.split(zoomIn).join('');
  for (const [, key] of body.matchAll(/mod && k === '([^']+)'/g)) ids.add(`mod+${key}`);
  // A Shift variant inside a Ctrl/Cmd block, such as Ctrl/Cmd+Shift+Z for redo.
  for (const [, key, block] of body.matchAll(/mod && k === '([^']+)'\)\s*\{([^}]*)\}/g)) {
    if (block.includes('e.shiftKey')) ids.add(`mod+shift+${key}`);
  }
  // Arrow keys are matched by the startsWith rule below.
  for (const [, key] of body.matchAll(/(?<!mod && )k === '([^']+)'/g)) {
    if (!key.startsWith('arrow')) ids.add(key);
  }
  for (const [, n] of body.matchAll(/e\.shiftKey && e\.code === 'Digit(\d)'/g)) ids.add(`shift+${n}`);
  if (body.includes("k.startsWith('arrow')")) ids.add('arrows');
  if (body.includes("e.code === 'Space'")) ids.add('space');
  return ids;
}

describe('keyboard shortcuts dialog', () => {
  const documented = new Set(SHORTCUTS.flatMap((s) => s.ids));
  const toolLetters = new Set(Object.keys(TOOL_KEYS));

  it('lists every single-key tool', () => {
    const missing = [...toolLetters].filter((key) => !documented.has(key));
    expect(missing).toEqual([]);
  });

  it('documents every key the keydown handler handles', () => {
    const undocumented = [...handledKeys()].filter((id) => !documented.has(id));
    expect(undocumented).toEqual([]);
  });

  it('finds every documented key in the keydown handler', () => {
    const handled = handledKeys();
    // Paste is a paste event, not a keydown; tool letters are handled through TOOL_KEYS.
    const unhandled = [...documented].filter((id) => !toolLetters.has(id) && id !== 'mod+v' && !handled.has(id));
    expect(unhandled).toEqual([]);
  });

  it('says ] brings to front and [ sends to back', () => {
    const row = (id: string) => SHORTCUTS.find((s) => s.ids.includes(id));
    expect(row(']')?.action).toMatch(/bring to front/i);
    expect(row('[')?.action).toMatch(/send to back/i);
  });
});
