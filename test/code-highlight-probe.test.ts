import { describe, expect, it } from 'vitest';
import { CODE_LANGS } from '../shared/code-langs.mjs';
import { createCodeTokenizer } from '../src/code-tokenize';
import { PROBE_INPUTS } from '../scripts/lib/code-probe-inputs.mjs';

// Every shipped grammar against hostile input, through the function the worker runs, with the 500-character and 50 ms per-line limits.
// Lines over 500 characters are drawn plain without running the grammar, so the single-line shapes and the lines of 501 must be cheap.
// A block of 40 lines of exactly 500 characters is the worst the grammars still see: each line can use its whole 50 ms limit, so a hostile
// block costs 2 s and, where one regex call cannot be interrupted (bash with `<`), 5 s of CPU on the main thread (11 runs over 1.5 s, scripts/code-highlight-probe.mjs). That is what the Worker and its
// 1.5 s watchdog are for, so that family is reported by the script and not asserted here.
const INPUTS = PROBE_INPUTS.filter((i) => !i.name.endsWith('(lines of 500)'));

describe.each(CODE_LANGS.filter((l) => l.shiki).map((l) => [l.id] as const))('hostile input, %s', (lang) => {
  it('finishes every probe input in under 2 s', async () => {
    const tokenizer = createCodeTokenizer();
    const base = { lang, shiki: 'github-light', surface: '#FFFFFF', ink: '#111111' };
    await tokenizer.tokenize({ ...base, text: 'x' });
    const slow: string[] = [];
    for (const input of INPUTS) {
      let ms = Infinity;
      // best of two: a loaded CI machine must not turn a 700 ms case into a failure
      for (let k = 0; k < 2 && ms >= 2000; k++) {
        const t0 = performance.now();
        const out = await tokenizer.tokenize({ ...base, text: input.text });
        ms = performance.now() - t0;
        expect(out!.map((l) => l.map((r) => r.t).join('')).join('\n')).toBe(input.text.replace(/\r\n?/g, '\n'));
      }
      if (ms >= 2000) slow.push(`${input.name}: ${Math.round(ms)} ms`);
    }
    expect(slow).toEqual([]);
  }, 120_000);
});
