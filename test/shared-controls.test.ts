import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SOURCE = new URL('../src/', import.meta.url).pathname;

function filesUnder(dir: string, extension: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? filesUnder(path, extension) : entry.isFile() && path.endsWith(extension) ? [path] : [];
  });
}

function closingParen(source: string, open: number): number {
  const stack = [')'];
  let quote = '';
  for (let i = open + 1; i < source.length; i++) {
    const char = source[i];
    if (quote) {
      if (char === '\\') i++;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'" || char === '`') { quote = char; continue; }
    if (char === '/' && source[i + 1] === '/') {
      i = source.indexOf('\n', i + 2);
      if (i < 0) return source.length;
      continue;
    }
    if (char === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      if (end < 0) return source.length;
      i = end + 1;
      continue;
    }
    if (char === '(') stack.push(')');
    else if (char === '{') stack.push('}');
    else if (char === '[') stack.push(']');
    else if (char === stack[stack.length - 1]) {
      stack.pop();
      if (!stack.length) return i;
    }
  }
  return source.length;
}

function argsOf(source: string, start: number, end: number): string[] {
  const args: string[] = [];
  let depth = 0;
  let from = start;
  let quote = '';
  for (let i = start; i < end; i++) {
    const char = source[i];
    if (quote) {
      if (char === '\\') i++;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'" || char === '`') { quote = char; continue; }
    if (char === '/' && source[i + 1] === '/') { i = source.indexOf('\n', i + 2); continue; }
    if (char === '/' && source[i + 1] === '*') { i = source.indexOf('*/', i + 2) + 1; continue; }
    if (char === '(' || char === '{' || char === '[') depth++;
    else if (char === ')' || char === '}' || char === ']') depth--;
    else if (char === ',' && depth === 0) {
      args.push(source.slice(from, i).trim());
      from = i + 1;
    }
  }
  if (from < end) args.push(source.slice(from, end).trim());
  return args;
}

function stringValues(text: string): string[] {
  return [...text.matchAll(/(?:'([^'\\]*(?:\\.[^'\\]*)*)'|"([^"\\]*(?:\\.[^"\\]*)*)"|`([^`$]*)`)/gu)]
    .map((match) => match[1] ?? match[2] ?? match[3] ?? '');
}

function propertyText(object: string, name: string): string {
  const match = object.match(new RegExp(`(?:^|[,\\s{])${name}\\s*:\\s*([^,}]+)`, 'u'));
  return match?.[1] ?? '';
}

interface HCall { start: number; end: number; args: string[]; tag: string; }

function hCalls(source: string): HCall[] {
  const calls: HCall[] = [];
  for (const match of source.matchAll(/\bh\s*\(/gu)) {
    const open = match.index! + match[0].lastIndexOf('(');
    const close = closingParen(source, open);
    const args = argsOf(source, open + 1, close);
    calls.push({ start: match.index!, end: close + 1, args, tag: stringValues(args[0] ?? '')[0] ?? '' });
  }
  return calls;
}

function checkboxRows(source: string, path: string): string[] {
  const missing: string[] = [];
  const calls = hCalls(source);
  for (const call of calls) {
    if (call.tag !== 'input') continue;
    const props = call.args[1] ?? '';
    const type = stringValues(propertyText(props, 'type'));
    const role = stringValues(propertyText(props, 'role'));
    if (!type.some((value) => value === 'checkbox' || value === 'radio') && !role.includes('switch')) continue;
    const declaration = source.slice(Math.max(0, call.start - 100), call.start).match(/(?:const|let|var)\s+([\w$]+)\s*=\s*$/u)?.[1];
    const inCheckRow = calls.some((row) => {
      if (row.start >= call.start || row.end < call.end) {
        if (!declaration || row.tag === 'input') return false;
      }
      const classes = stringValues(propertyText(row.args[1] ?? '', 'class')).flatMap((value) => value.split(/\s+/u));
      if (!classes.includes('check') || row.args.length < 3) return false;
      const children = row.args.slice(2).join(',');
      return (call.start >= row.start && call.end <= row.end && children.includes(source.slice(call.start, call.end)))
        || (declaration !== undefined && new RegExp(`\\b${declaration}\\b`, 'u').test(children));
    });
    if (!inCheckRow) missing.push(`${path}:${source.slice(0, call.start).split('\n').length}`);
  }
  return missing;
}

function controlRules(css: string): { selector: string; declarations: string }[] {
  return [...css.replace(/\/\*[\s\S]*?\*\//gu, '').matchAll(/([^{}]+)\{([^{}]*)\}/gu)]
    .map((match) => ({ selector: match[1].trim(), declarations: match[2] }))
    .filter(({ selector }) => /input\s*\[[^\]]*(?:checkbox|radio|role\s*=\s*['"]switch)|\[role\s*=\s*['"]switch/iu.test(selector));
}

function allRules(css: string): { selector: string; declarations: string }[] {
  return [...css.replace(/\/\*[\s\S]*?\*\//gu, '').matchAll(/([^{}]+)\{([^{}]*)\}/gu)]
    .map((match) => ({ selector: match[1].trim(), declarations: match[2] }));
}

describe('shared check controls', () => {
  it('puts checkbox and radio inputs in a shared check row', () => {
    const missing = filesUnder(SOURCE, '.ts').flatMap((path) => {
      const text = readFileSync(path, 'utf8');
      return checkboxRows(text, relative(SOURCE, path).replaceAll('\\', '/'));
    });
    // No exceptions: every native check control has a visible, clickable .check row.
    expect(missing).toEqual([]);
  });

  it('keeps native check styling in the shared rule and permits accent only for the shared range input', () => {
    const violations: string[] = [];
    for (const path of filesUnder(SOURCE, '.css')) {
      const name = relative(SOURCE, path).replaceAll('\\', '/');
      const rules = allRules(readFileSync(path, 'utf8'));
      for (const { selector, declarations } of controlRules(rules.map((rule) => `${rule.selector}{${rule.declarations}}`).join('\n'))) {
        const widthOrHeight = !selector.includes('::') && /(?:^|;)\s*(?:width|height)\s*:/iu.test(declarations);
        const sharedBox = name === 'styles.css' && /^(?:input\[type=['"]checkbox['"]\], input\[type=['"]radio['"]\]|input\[role=['"]switch['"]\]|\[role=['"]switch['"]\]:not\(input\))$/iu.test(selector);
        const checkHitArea = name === 'styles.css' && /^\.check:has\(input\[type=['"](?:checkbox|radio)['"]\]\)/iu.test(selector)
          && /(?:^|;)\s*min-height\s*:\s*44px/iu.test(declarations)
          && !/(?:^|;)\s*(?:width|height)\s*:/iu.test(declarations);
        if (widthOrHeight && !sharedBox && !checkHitArea) violations.push(`${name}: control dimensions in ${selector}`);
      }
      for (const { selector, declarations } of rules) {
        if (/accent-color\s*:/iu.test(declarations) && !(name === 'styles.css' && selector === '.range')) violations.push(`${name}: accent-color in ${selector}`);
      }
    }
    expect(violations).toEqual([]);
  });
});
