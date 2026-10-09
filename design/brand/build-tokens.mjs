// Builds tokens.css from tokens.json. Run: node design/brand/build-tokens.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const t = JSON.parse(readFileSync(join(here, 'tokens.json'), 'utf8'));
const decls = (group, indent = '  ') =>
  Object.entries(group)
    .filter(([k]) => k.startsWith('--tb-'))
    .map(([k, v]) => `${indent}${k}: ${v};`)
    .join('\n');

const css = `/* Tabula brand tokens (TAB-196). Generated from tokens.json by build-tokens.mjs; edit the JSON, not this file.
   Light is the default. Dark applies with prefers-color-scheme: dark, unless the page sets data-tb-scheme="light";
   data-tb-scheme="dark" forces it. */
:root {
  /* palette */
${decls(t.palette)}
  /* roles, light */
${decls(t.light)}
  /* type */
${decls(t.type)}
  /* space */
${decls(t.space)}
  /* layout */
${decls(t.layout)}
  /* shape */
${decls(t.shape)}
  /* motion */
${decls(t.motion)}
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-tb-scheme="light"]) {
${decls(t.dark, '    ')}
    color-scheme: dark;
  }
}
:root[data-tb-scheme="dark"] {
${decls(t.dark)}
  color-scheme: dark;
}
`;
writeFileSync(join(here, 'tokens.css'), css);
console.log('tokens.css written');
