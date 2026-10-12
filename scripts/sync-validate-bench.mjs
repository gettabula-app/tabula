#!/usr/bin/env node
// Cost of the sync guard (server/sync-guard.mjs) per client message, with the guard off and in report mode (and enforce for
// the big messages). It applies real Yjs updates to a server document the way Room.onMessage does and times only that.
// No dependencies beyond the repository's own. Run it under `nice`; on a loaded machine the numbers are noisy, so it prints
// the load average and takes the best of several rounds for each figure.
//
// Usage: nice node scripts/sync-validate-bench.mjs [--rounds 5] [--json]
import os from 'node:os';
import * as Y from 'yjs';
import { createSyncGuard } from '../server/sync-guard.mjs';

const args = process.argv.slice(2);
const rounds = Number(args[args.indexOf('--rounds') + 1]) || 5;
const json = args.includes('--json');

const ctx = { writer: { id: 'u1', name: 'Lea' }, isBoardMember: () => true, canEditObject: () => true, createdByPolicy: 'member' };
const ws = {};
const stickyEntries = (i, extra = {}) => Object.entries({
  id: `s${i}`, type: 'sticky', x: i % 100, y: Math.floor(i / 100), w: 192, h: 192, rotation: 0, z: `a${i}`, text: `note ${i}`, fill: '#FFE16B', fontSize: 18, createdBy: 'u1', updatedAt: 1_700_000_000_000, ...extra,
});

const pct = (arr, p) => {
  const a = [...arr].sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.floor((p / 100) * a.length))];
};

/** A fake room around a real document, the part of Room the guard touches. */
function makeRoom() {
  const doc = new Y.Doc({ gc: true });
  const room = { kind: 'board', doc, held: null, broadcastUpdate() {} };
  doc.on('update', (u) => { if (room.held) room.held.push(u); });
  return room;
}

/**
 * `prepare(room)` seeds the server and returns a list of messages (client updates); `time(room, update)` applies one.
 * Returns the per-message times in microseconds.
 */
function measure(mode, scenario) {
  const guard = createSyncGuard({ mode, log: () => {} });
  const room = makeRoom();
  const client = new Y.Doc();
  scenario.seed?.(client);
  Y.applyUpdate(room.doc, Y.encodeStateAsUpdate(client));
  const updates = [];
  client.on('update', (u) => updates.push(u));
  scenario.edit(client);
  const times = [];
  for (const u of updates) {
    const apply = () => Y.applyUpdate(room.doc, u, ws);
    const t0 = process.hrtime.bigint();
    if (guard.enabled) guard.run(room, ws, ctx, apply); else apply();
    times.push(Number(process.hrtime.bigint() - t0) / 1000);
  }
  return times;
}

const scenarios = [
  {
    name: 'typing: one sticky text change (x1000)',
    modes: ['off', 'report', 'enforce'],
    seed: (c) => { const o = c.getMap('objects'); for (let i = 0; i < 300; i++) o.set(`s${i}`, new Y.Map(stickyEntries(i))); },
    edit: (c) => { const m = c.getMap('objects').get('s7'); for (let i = 0; i < 1000; i++) m.set('text', `note 7 typed ${i}`); },
  },
  {
    name: 'bulk edit: move 500 objects (x40 messages)',
    modes: ['off', 'report', 'enforce'],
    seed: (c) => { const o = c.getMap('objects'); for (let i = 0; i < 600; i++) o.set(`s${i}`, new Y.Map(stickyEntries(i))); },
    edit: (c) => {
      for (let n = 1; n <= 40; n++) c.transact(() => { const o = c.getMap('objects'); for (let i = 0; i < 500; i++) { const m = o.get(`s${i}`); m.set('x', i + n); m.set('y', n); } });
    },
  },
  {
    name: 'paste: 5,000 new objects in one message (x8 rooms)',
    modes: ['off', 'report', 'enforce'],
    repeat: 8,
    seed: () => {},
    edit: (c) => { c.transact(() => { const o = c.getMap('objects'); for (let i = 0; i < 5000; i++) o.set(`n${i}`, new Y.Map(stickyEntries(i, { id: `n${i}` }))); }); },
  },
  {
    name: '20,000-character text edit (x200)',
    modes: ['off', 'report', 'enforce'],
    seed: (c) => { const o = c.getMap('objects'); o.set('long', new Y.Map(stickyEntries(1, { id: 'long', text: 'a'.repeat(20_000) }))); },
    edit: (c) => { const m = c.getMap('objects').get('long'); for (let i = 0; i < 200; i++) m.set('text', `${i}`.repeat(1) + 'b'.repeat(19_999)); },
  },
];

const results = [];
for (const sc of scenarios) {
  const row = { scenario: sc.name, modes: {} };
  for (const mode of sc.modes) {
    let best = null;
    let minOf = Infinity;
    for (let r = 0; r < rounds; r++) {
      let times = [];
      for (let k = 0; k < (sc.repeat ?? 1); k++) times = times.concat(measure(mode, sc));
      const stat = { min: Math.min(...times), p50: pct(times, 50), p99: pct(times, 99), mean: times.reduce((a, b) => a + b, 0) / times.length, n: times.length };
      if (!best || stat.p50 < best.p50) best = stat;
      minOf = Math.min(minOf, stat.min);
    }
    row.modes[mode] = { ...best, min: minOf };
  }
  results.push(row);
}

const load = os.loadavg();
if (json) {
  console.log(JSON.stringify({ load, cpus: os.cpus().length, node: process.version, rounds, results }, null, 2));
} else {
  console.log(`node ${process.version}, ${os.cpus().length} cpus, load average ${load.map((x) => x.toFixed(1)).join(' ')}, best of ${rounds} rounds per figure; min is the least disturbed sample`);
  const f = (us) => (us >= 1000 ? `${(us / 1000).toFixed(2)} ms` : `${us.toFixed(0)} us`);
  console.log(`${'scenario'.padEnd(54)} ${'mode'.padEnd(8)} ${'n'.padStart(5)} ${'p50'.padStart(10)} ${'p99'.padStart(10)} ${'+p50'.padStart(10)} ${'+p99'.padStart(10)} ${'min'.padStart(10)} ${'+min'.padStart(10)} ${'x base'.padStart(7)}`);
  for (const r of results) {
    const base = r.modes.off;
    for (const [mode, s] of Object.entries(r.modes)) {
      const dp50 = s.p50 - base.p50;
      const dp99 = s.p99 - base.p99;
      console.log(`${(mode === 'off' ? r.scenario : '').padEnd(54)} ${mode.padEnd(8)} ${String(s.n).padStart(5)} ${f(s.p50).padStart(10)} ${f(s.p99).padStart(10)} ${(mode === 'off' ? '-' : f(dp50)).padStart(10)} ${(mode === 'off' ? '-' : f(dp99)).padStart(10)} ${f(s.min).padStart(10)} ${(mode === 'off' ? '-' : f(s.min - base.min)).padStart(10)} ${(mode === 'off' ? '1.0' : (s.p50 / base.p50).toFixed(1)).padStart(7)}`);
    }
  }
}
