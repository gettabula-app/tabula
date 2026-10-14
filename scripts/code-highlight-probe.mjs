#!/usr/bin/env node
// ReDoS probe for the code highlighter: every shipped language against hostile inputs, through the same tokenising function the worker runs, with the
// 500-character per-line and 50 ms per-line limits. Prints CPU time per language and input, worst first. A case over ~1.5 s is one the Worker and
// its watchdog exist for. Usage: node scripts/code-highlight-probe.mjs [--top N] [--lang id]
import { createServer } from 'vite';
import { PROBE_INPUTS } from './lib/code-probe-inputs.mjs';

const args = process.argv.slice(2);
const top = Number(args[args.indexOf('--top') + 1]) || 15;
const only = args.includes('--lang') ? args[args.indexOf('--lang') + 1] : null;
const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
try {
  const { createCodeTokenizer } = await vite.ssrLoadModule('/src/code-tokenize.ts');
  const { CODE_LANGS } = await vite.ssrLoadModule('/shared/code-langs.mjs');
  const rows = [];
  for (const lang of CODE_LANGS.filter((l) => l.shiki && (!only || l.id === only))) {
    const tokenizer = createCodeTokenizer();
    const base = { lang: lang.id, shiki: 'github-light', surface: '#ffffff', ink: '#111111' };
    await tokenizer.tokenize({ ...base, text: 'x' }); // load grammar and theme outside the timing
    for (const input of PROBE_INPUTS) {
      // CPU time of this process, not wall time: the work is single-threaded, and on a busy machine wall time only measures the queue.
      const c0 = process.cpuUsage();
      await tokenizer.tokenize({ ...base, text: input.text });
      const c = process.cpuUsage(c0);
      rows.push({ lang: lang.id, input: input.name, ms: Math.round((c.user + c.system) / 1000) });
    }
  }
  rows.sort((a, b) => b.ms - a.ms);
  console.log(`${rows.length} runs; worst ${top}:`);
  for (const r of rows.slice(0, top)) console.log(`${String(r.ms).padStart(7)} ms  ${r.lang.padEnd(10)} ${r.input}`);
  const family = (r) => (/lines of (\d+)\)$/.exec(r.input)?.[0] ?? (r.input === '3000 lines of x' ? '3000 lines' : 'single-line shapes'));
  const worst = new Map();
  for (const r of rows) {
    const k = `${r.lang}|${family(r)}`;
    if (!worst.has(k)) worst.set(k, r);
  }
  console.log('worst per language, family (lines of 500 / 3000 lines):');
  for (const lang of new Set(rows.map((r) => r.lang))) {
    const cell = (f) => `${f}: ${worst.get(`${lang}|${f}`)?.ms ?? '-'} ms`;
    console.log(`  ${lang.padEnd(10)} ${cell('lines of 500)')}  ${cell('3000 lines')}`);
  }
  const slow = rows.filter((r) => r.ms >= 1500);
  console.log(`over 1500 ms: ${slow.length}`);
} finally {
  await vite.close();
}
