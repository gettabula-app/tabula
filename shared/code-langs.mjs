// The languages a code block can be highlighted as (docs/code-blocks.md). One list for the client, the sync validator, MCP, templates and the
// import sanitiser, so none of them accepts a value another refuses. `shiki` is the grammar's module name under shiki/langs/ (loaded on demand, one chunk each);
// plain text has none. The ids are stored on the object (`lang`), the labels are what a person reads.

/** @type {ReadonlyArray<Readonly<{ id: string, label: string, shiki: string | null }>>} */
export const CODE_LANGS = Object.freeze([
  { id: 'plaintext', label: 'Plain text', shiki: null },
  { id: 'ts', label: 'TypeScript', shiki: 'typescript' },
  { id: 'tsx', label: 'TSX', shiki: 'tsx' },
  { id: 'js', label: 'JavaScript', shiki: 'javascript' },
  { id: 'jsx', label: 'JSX', shiki: 'jsx' },
  { id: 'json', label: 'JSON', shiki: 'json' },
  { id: 'html', label: 'HTML', shiki: 'html' },
  { id: 'css', label: 'CSS', shiki: 'css' },
  { id: 'scss', label: 'SCSS', shiki: 'scss' },
  { id: 'python', label: 'Python', shiki: 'python' },
  { id: 'rust', label: 'Rust', shiki: 'rust' },
  { id: 'go', label: 'Go', shiki: 'go' },
  { id: 'java', label: 'Java', shiki: 'java' },
  { id: 'c', label: 'C', shiki: 'c' },
  { id: 'cpp', label: 'C++', shiki: 'cpp' },
  { id: 'csharp', label: 'C#', shiki: 'csharp' },
  { id: 'bash', label: 'Shell', shiki: 'bash' },
  { id: 'sql', label: 'SQL', shiki: 'sql' },
  { id: 'yaml', label: 'YAML', shiki: 'yaml' },
  { id: 'toml', label: 'TOML', shiki: 'toml' },
  { id: 'markdown', label: 'Markdown', shiki: 'markdown' },
  { id: 'diff', label: 'Diff', shiki: 'diff' },
  { id: 'php', label: 'PHP', shiki: 'php' },
  { id: 'ruby', label: 'Ruby', shiki: 'ruby' },
  { id: 'swift', label: 'Swift', shiki: 'swift' },
  { id: 'kotlin', label: 'Kotlin', shiki: 'kotlin' },
]);

export const CODE_LANG_IDS = Object.freeze(CODE_LANGS.map((l) => l.id));
export const DEFAULT_CODE_LANG = 'plaintext';
/** The 12 languages the picker lists first (after Plain text); the rest follow alphabetically. */
export const COMMON_CODE_LANGS = Object.freeze(['ts', 'js', 'json', 'html', 'css', 'python', 'bash', 'sql', 'yaml', 'go', 'rust', 'java']);

/** A code block holds at most this many characters; longer text is stored but drawn as plain text (no highlighting). */
export const MAX_CODE_CHARS = 20_000;
export const MAX_CODE_TITLE = 100;

/** Fenced-block names people type (```ts) to the stored id; anything else is plain text. */
const ALIASES = Object.freeze({
  typescript: 'ts', javascript: 'js', node: 'js', mjs: 'js', cjs: 'js', py: 'python', python3: 'python', rs: 'rust', golang: 'go', 'c++': 'cpp', cc: 'cpp',
  'c#': 'csharp', cs: 'csharp', sh: 'bash', shell: 'bash', zsh: 'bash', shellscript: 'bash', yml: 'yaml', md: 'markdown', patch: 'diff', rb: 'ruby', kt: 'kotlin',
  text: 'plaintext', txt: 'plaintext', plain: 'plaintext',
});

/** The stored language id for a value a person or an agent typed, or null when it is not a language Tabula highlights. */
export function normaliseCodeLang(value) {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  if (CODE_LANG_IDS.includes(v)) return v;
  return Object.hasOwn(ALIASES, v) ? ALIASES[v] : null;
}

export const isCodeLang = (value) => typeof value === 'string' && CODE_LANG_IDS.includes(value);
export const codeLangLabel = (id) => CODE_LANGS.find((l) => l.id === id)?.label ?? 'Plain text';
