// Hostile inputs for the code highlighter's ReDoS probe (scripts/code-highlight-probe.mjs, test/code-highlight-probe.test.ts).
const N = 20_000;
const rep = (s, n = N) => s.repeat(Math.ceil(n / s.length)).slice(0, n);

const SHAPES = [
  ...['"', "'", '/', '<', '(', '`', '\\', '[', '{', 'a'].map((c) => ({ name: `${c} x${N}`, text: c.repeat(N) })),
  { name: '/* + x*19998', text: '/*' + 'x'.repeat(N - 2) },
  { name: '("\\")x5000 nested quotes', text: rep('"\\"', 15_000) + rep("'\\'", 5000) },
  { name: 'one 20000-char line of words', text: rep('foo(bar, "baz") ') },
  { name: '3000 lines of x', text: Array.from({ length: 3000 }, () => 'x').join('\n') },
  { name: '</ + <!-- runs', text: rep('<!--</a ') },
  { name: '$( ${ `` mix', text: rep('$(${`') },
  { name: '1e + dots', text: rep('1.0e+.') },
];

/** Lines of exactly `n` characters. 500 is the longest line the grammar really runs on (MAX_HIGHLIGHT_LINE); 501 is skipped and drawn plain. */
const chunked = (text, n) => text.replace(new RegExp(`([^\\n]{${n}})(?=[^\\n])`, 'g'), '$1\n');

/** @type {ReadonlyArray<Readonly<{ name: string, text: string }>>} */
export const PROBE_INPUTS = Object.freeze([
  ...SHAPES.map((s) => ({ name: s.name, text: s.text })),
  ...[500, 501].flatMap((n) => SHAPES.filter((s) => !s.text.includes('\n')).map((s) => ({ name: `${s.name} (lines of ${n})`, text: chunked(s.text, n) }))),
]);
