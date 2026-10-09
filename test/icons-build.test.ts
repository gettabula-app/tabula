import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { buildSet, browseOrder, canonicalJson, checkSet, gateBody, gzip, licenceTier, licensesText, packShards } from '../scripts/lib/icons-build.mjs';
import { CURATED_SETS, EXCLUDED_SETS, buildIcons, runPool } from '../scripts/build-icons.mjs';

const dirs: string[] = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'tabula-icons-'));
  dirs.push(d);
  return d;
};
// A build that fails stops at the first error while the other sets in its pool of six are still being written, so the
// directory it was building in can gain files while it is removed (ENOTEMPTY). Retrying lets the writes finish.
afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const info = (over: Record<string, unknown> = {}) => ({ name: 'Set', license: { title: 'MIT', spdx: 'MIT', url: 'https://example.com/LICENSE' }, author: { name: 'Ada', url: 'https://example.com' }, ...over });
const path24 = (n: string) => `<path d="${n}"/>`;

describe('licence rule', () => {
  it('gives each allowed id its class', () => {
    const table: Record<string, string> = {
      'CC0-1.0': 'public', Unlicense: 'public', '0BSD': 'public',
      MIT: 'notice', ISC: 'notice', 'Apache-2.0': 'notice', 'BSD-2-Clause': 'notice', 'BSD-3-Clause': 'notice', 'OFL-1.1': 'notice',
      'CC-BY-3.0': 'attribution', 'CC-BY-4.0': 'attribution',
    };
    expect(Object.keys(table).map((id) => licenceTier(id))).toEqual(Object.values(table));
  });

  it('blocks NonCommercial, ShareAlike, copyleft, compound, empty and missing licences', () => {
    const blocked = ['CC-BY-NC-4.0', 'CC-BY-NC-SA-4.0', 'CC-BY-SA-4.0', 'CC-BY-SA-3.0', 'GPL-2.0-only', 'GPL-3.0-or-later', 'LGPL-3.0', 'AGPL-3.0', 'MPL-2.0', 'EPL-2.0', 'MIT OR Apache-2.0', 'mit', ' MIT', 'Custom', ''];
    expect(blocked.filter((id) => licenceTier(id) !== null)).toEqual([]);
    expect(licenceTier(undefined)).toBeNull();
    expect(checkSet({ name: 'x' }).ok).toBe(false);
  });

  it('blocks a NonCommercial title even when the id looks allowed', () => {
    expect(licenceTier('MIT', 'Creative Commons Attribution NonCommercial')).toBeNull();
    expect(licenceTier('CC-BY-4.0', 'CC BY-NC 4.0')).toBeNull();
    expect(licenceTier('CC-BY-4.0', 'CC BY 4.0')).toBe('attribution');
  });

  it('blocks a hidden set whatever its licence', () => {
    expect(checkSet(info())).toEqual({ ok: true, tier: 'notice' });
    expect(checkSet(info({ hidden: true })).ok).toBe(false);
  });
});

describe('packer', () => {
  const sizeOf = (n: string) => n.length;

  it('puts every icon in exactly one shard, in order', () => {
    const order = Array.from({ length: 250 }, (_, i) => `icon-${String(i).padStart(3, '0')}`);
    const shards = packShards(order, sizeOf, { shardIcons: 96, shardBytes: 1e9 });
    expect(shards.map((s: string[]) => s.length)).toEqual([96, 96, 58]);
    expect(shards.flat()).toEqual(order);
  });

  it('closes a shard at the byte limit too', () => {
    const order = ['a', 'b', 'c', 'd', 'e'];
    const shards = packShards(order, () => 40, { shardIcons: 96, shardBytes: 100 });
    expect(shards).toEqual([['a', 'b'], ['c', 'd'], ['e']]);
  });

  it('gives a single oversized body its own shard', () => {
    const shards = packShards(['a', 'huge', 'b'], (n: string) => (n === 'huge' ? 500 : 10), { shardIcons: 96, shardBytes: 100 });
    expect(shards).toEqual([['a'], ['huge'], ['b']]);
  });

  it('orders by name, or by category first when the set has categories', () => {
    expect(browseOrder(['b', 'c', 'a'], undefined)).toEqual(['a', 'b', 'c']);
    expect(browseOrder(['a', 'b', 'c', 'd'], { Z: ['c', 'gone'], Y: ['b', 'c'] })).toEqual(['c', 'b', 'a', 'd']);
  });
});

describe('shards and defaults', () => {
  const data = {
    info: info(), width: 24, height: 24,
    icons: {
      home: { body: path24('h') },
      wide: { body: path24('w'), width: 32 },
      shifted: { body: path24('s'), left: -2, top: 3 },
      same: { body: path24('same'), width: 24, height: 24 },
    },
  };

  it('stores only what differs from the set default and round-trips the source body', () => {
    const { files } = buildSet('demo', data);
    const shard = JSON.parse(files.find((f: { path: string }) => f.path.startsWith('s/'))!.data.toString());
    expect(shard.w).toBe(24);
    expect(shard.h).toBe(24);
    expect(shard.i.home).toBe(path24('h'));
    expect(shard.i.same).toBe(path24('same'));
    expect(shard.i.wide).toEqual({ b: path24('w'), w: 32 });
    expect(shard.i.shifted).toEqual({ b: path24('s'), l: -2, t: 3 });
    for (const [name, ic] of Object.entries(data.icons)) {
      const e = shard.i[name];
      expect(typeof e === 'string' ? e : e.b).toBe(ic.body);
    }
  });

  it('keeps a set-wide left and top in the shard', () => {
    const { files } = buildSet('demo', { ...data, left: -1, top: -1, icons: { a: { body: 'x' } } });
    const shard = JSON.parse(files[0].data.toString());
    expect(shard).toMatchObject({ l: -1, t: -1, i: { a: 'x' } });
  });

  it('names a file by the hash of its uncompressed content', () => {
    const a = buildSet('demo', data);
    const b = buildSet('demo', structuredClone(data));
    expect(a.files.map((f: { path: string }) => f.path)).toEqual(b.files.map((f: { path: string }) => f.path));
    expect(a.files[0].path).toMatch(/^s\/demo\.0\.[0-9a-f]{8}\.json$/);
  });

  it('writes the same bytes whatever order the source keys come in', () => {
    expect(canonicalJson({ b: 1, a: { d: 1, c: 2 } }).toString()).toBe('{"a":{"c":2,"d":1},"b":1}');
  });

  it('gzips to the same bytes everywhere', async () => {
    const out = await gzip(Buffer.from('hello'));
    expect(out[9]).toBe(3);
    expect(zlib.gunzipSync(out).toString()).toBe('hello');
  });
});

describe('index', () => {
  const data = {
    info: info(), width: 16, height: 16,
    icons: { arrow: { body: path24('a') }, 'arrow-left': { body: path24('al') }, box: { body: path24('b'), width: 20, height: 18 } },
    aliases: {
      back: { parent: 'arrow-left' },
      'back-again': { parent: 'back' },
      dangling: { parent: 'nowhere' },
      'arrow-right': { parent: 'arrow-left', hFlip: true },
      'box-tall': { parent: 'box', rotate: 1 },
    },
    categories: { Arrows: ['arrow-left', 'back', 'arrow'], Empty: ['gone'] },
  };
  const built = buildSet('demo', data);
  const index = JSON.parse(built.files.find((f: { path: string }) => f.path.startsWith('i/'))!.data.toString());
  const shard = JSON.parse(built.files.find((f: { path: string }) => f.path.startsWith('s/'))!.data.toString());

  it('lists names in browse order and points aliases at the right icon', () => {
    expect(index.n.slice(0, 2)).toEqual(['arrow-left', 'arrow']);
    expect(index.n).toContain('arrow-right');
    const at = (name: string) => index.n.indexOf(name);
    const alias = Object.fromEntries(index.a);
    expect(alias.back).toBe(at('arrow-left'));
    expect(alias['back-again']).toBe(at('arrow-left'));
    expect(alias).not.toHaveProperty('dangling');
  });

  it('turns a flipped alias into an icon whose body wraps the parent, and keeps plain aliases as pointers', () => {
    const e = shard.i['arrow-right'];
    expect(e).toBe(`<g transform="translate(16 0) scale(-1 1)">${path24('al')}</g>`);
    expect(index.a.map(([n]: [string]) => n)).not.toContain('arrow-right');
  });

  it('rotates a non-square icon about its centre and swaps the box', () => {
    const e = shard.i['box-tall'];
    expect(e.b).toBe(`<g transform="rotate(90 10 9)">${path24('b')}</g>`);
    expect(e).toMatchObject({ w: 18, h: 20, l: 1, t: -1 });
  });

  it('turns categories into index lists, dropping names that are not in the set', () => {
    expect(index.c).toEqual({ Arrows: [0, 1] });
    expect(index.c).not.toHaveProperty('Empty');
  });

  it('lists shards whose counts add up to the icon count', () => {
    const { entry } = built;
    expect(index.sh.reduce((n: number, [, c]: [string, number]) => n + c, 0)).toBe(index.n.length);
    expect(entry.n).toBe(index.n.length);
    expect(entry.sh).toBe(index.sh.length);
  });

  it('splits a big set into several shards', () => {
    const icons = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`i${String(i).padStart(3, '0')}`, { body: path24(String(i)) }]));
    const { files, entry } = buildSet('big', { info: info(), icons }, { shardIcons: 96 });
    expect(entry.sh).toBe(3);
    expect(files.filter((f: { path: string }) => f.path.startsWith('s/'))).toHaveLength(3);
  });
});

describe('body gate', () => {
  it('fails on anything executable or external', () => {
    const bad: Record<string, string> = {
      '<script': '<script>alert(1)</script>',
      'an on* attribute': '<path onload="x()" d="M0 0"/>',
      'javascript:': '<a href="javascript:alert(1)"><path d="M0 0"/></a>',
      '<foreignObject': '<foreignObject><div/></foreignObject>',
      '<style': '<style>path{fill:red}</style>',
      'an external href': '<use href="https://example.com/x.svg#a"/>',
      'url(http': '<path fill="url(https://example.com/p)"/>',
      '<image': '<image href="x.png"/>',
      'data:image': '<path style="background:url(data:image/png;base64,AAAA)"/>',
      'an animation of href': '<a><animate attributeName="xlink:href" values="a;b"/></a>',
    };
    expect(Object.values(bad).map((body) => gateBody(body))).toEqual(Object.keys(bad));
  });

  it('passes ordinary bodies, including ones that animate something else', () => {
    expect(gateBody('<path fill="currentColor" d="M12 2L2 7l10 5l10-5z"/>')).toBeNull();
    expect(gateBody('<g><circle cx="12" cy="12" r="3"><animate attributeName="r" values="3;6;3" dur="1s"/></circle></g>')).toBeNull();
    expect(gateBody('<linearGradient id="a"><stop offset="0" stop-color="#fff"/></linearGradient><path fill="url(#a)" d="M0 0"/>')).toBeNull();
    expect(gateBody('<use href="#a"/>')).toBeNull();
  });

  it('stops the build with the icon and the pattern', () => {
    const data = { info: info(), icons: { ok: { body: path24('x') }, evil: { body: '<script>x</script>' } } };
    expect(() => buildSet('demo', data)).toThrow('demo:evil matches <script');
  });
});

describe('licence text', () => {
  it('lists every set with author and licence, and notes the trademarks', () => {
    const text = licensesText([
      { p: 'b', name: 'Beta', n: 2, tm: true, lic: { id: 'CC0-1.0', title: 'CC0 1.0', url: 'https://example.com/cc0' }, au: { name: 'Bo', url: 'https://example.com/bo' } },
      { p: 'a', name: 'Alpha', n: 1, lic: { id: 'MIT', title: 'MIT' } },
    ], '@iconify/json 1.0.0');
    expect(text.indexOf('Alpha (a)')).toBeLessThan(text.indexOf('Beta (b) (logos)'));
    expect(text).toContain('Author:  Bo <https://example.com/bo>');
    expect(text).toContain('Licence: CC0 1.0 (CC0-1.0) <https://example.com/cc0>');
    expect(text).toContain('Licence: MIT\n');
    expect(text).toContain('trademarks');
    expect(text).toContain('@iconify/json 1.0.0');
  });
});

describe('build over a fixture', () => {
  const makeSource = (extra: Record<string, unknown> = {}) => {
    const src = tmp();
    fs.mkdirSync(path.join(src, 'json'));
    fs.writeFileSync(path.join(src, 'package.json'), JSON.stringify({ version: '9.9.9' }));
    const sets: Record<string, unknown> = {
      beta: { prefix: 'beta', info: info({ name: 'Beta' }), width: 24, height: 24, icons: { b1: { body: path24('b1') }, b2: { body: path24('b2') } } },
      alpha: {
        prefix: 'alpha', info: info({ name: 'Alpha', license: { title: 'CC BY 4.0', spdx: 'CC-BY-4.0' } }), width: 24, height: 24,
        icons: { a1: { body: path24('a1') }, a2: { body: path24('a2') } }, aliases: { one: { parent: 'a1' } },
      },
      ...extra,
    };
    for (const [p, v] of Object.entries(sets)) fs.writeFileSync(path.join(src, 'json', `${p}.json`), JSON.stringify(v));
    return src;
  };
  const read = (out: string, file: string) => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(out, `${file}.gz`))).toString());
  const tree = (dir: string, base = dir): Record<string, string> => Object.assign({}, ...fs.readdirSync(dir, { withFileTypes: true }).map((e) => (
    e.isDirectory() ? tree(path.join(dir, e.name), base) : { [path.relative(base, path.join(dir, e.name)).replaceAll('\\', '/')]: fs.readFileSync(path.join(dir, e.name)).toString('base64') }
  )));

  it('writes a manifest, gzipped hashed files and LICENSES.txt', async () => {
    const source = makeSource();
    const out = path.join(tmp(), 'icons');
    await buildIcons({ source, out, pinned: [], priority: ['beta'] });
    const manifest = read(out, 'manifest.json');
    expect(manifest.v).toBe(1);
    expect(manifest.sets.map((s: { p: string }) => s.p)).toEqual(['beta', 'alpha']);
    const alpha = manifest.sets[1];
    expect(alpha).toMatchObject({ n: 2, name: 'Alpha', lic: { id: 'CC-BY-4.0', tier: 'attribution' }, au: { name: 'Ada' }, sh: 1 });
    expect(alpha.gz).toBeGreaterThan(0);
    expect(manifest).not.toHaveProperty('pin');
    const index = read(out, `i/alpha.${alpha.idx}.json`);
    expect(index.n).toEqual(['a1', 'a2']);
    expect(index.a).toEqual([['one', 0]]);
    const shard = read(out, `s/alpha.0.${index.sh[0][0]}.json`);
    expect(shard.i.a1).toBe(path24('a1'));
    expect(fs.readFileSync(path.join(out, 'LICENSES.txt'), 'utf8')).toContain('Alpha (alpha)');
    expect(fs.existsSync(path.join(out, 'manifest.json'))).toBe(false);
  });

  it('gives byte-identical output on a second build, with and without the cache', async () => {
    const source = makeSource();
    const base = tmp();
    const opts = { source, pinned: [], cacheDir: path.join(base, 'cache') };
    const first = await buildIcons({ ...opts, out: path.join(base, 'a') });
    const second = await buildIcons({ ...opts, out: path.join(base, 'b') });
    const plain = await buildIcons({ source, pinned: [], out: path.join(base, 'c') });
    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(plain.cached).toBe(false);
    expect(tree(path.join(base, 'b'))).toEqual(tree(path.join(base, 'a')));
    expect(tree(path.join(base, 'c'))).toEqual(tree(path.join(base, 'a')));
    expect(fs.statSync(path.join(base, 'b', 'manifest.json.gz')).mtime).toEqual(fs.statSync(path.join(base, 'a', 'manifest.json.gz')).mtime);
  });

  it('rebuilds when the set selection changes and keeps one cache entry', async () => {
    const source = makeSource();
    const base = tmp();
    const cacheDir = path.join(base, 'cache');
    await buildIcons({ source, pinned: [], cacheDir, out: path.join(base, 'a') });
    const only = await buildIcons({ source, pinned: [], cacheDir, sets: ['beta'], out: path.join(base, 'a') });
    expect(only.cached).toBe(false);
    expect(only.sets.map((s: { p: string }) => s.p)).toEqual(['beta']);
    expect(fs.readdirSync(cacheDir)).toHaveLength(1);
  });

  it('skips hidden, blocked and excluded sets when building everything', async () => {
    const source = makeSource({
      secret: { prefix: 'secret', info: info({ hidden: true }), icons: { x: { body: path24('x') } } },
      sharealike: { prefix: 'sharealike', info: info({ license: { title: 'CC BY-SA 4.0', spdx: 'CC-BY-SA-4.0' } }), icons: { x: { body: path24('x') } } },
      dropped: { prefix: 'dropped', info: info(), icons: { x: { body: path24('x') } } },
      old: { prefix: 'old', info: info({ category: 'Archive / Unmaintained' }), icons: { x: { body: path24('x') } } },
    });
    const out = path.join(tmp(), 'icons');
    const r = await buildIcons({ source, out, pinned: [], exclude: ['dropped'] });
    expect(r.sets.map((s: { p: string }) => s.p)).toEqual(['alpha', 'beta']);
    expect(r.skipped).toEqual({ hidden: 1, licence: 1, archived: 1 });
  });

  it('stops the build for a listed set with a blocked licence, naming the set and the licence', async () => {
    const source = makeSource({ gpl: { prefix: 'gpl', info: info({ license: { title: 'GPL 3.0', spdx: 'GPL-3.0-or-later' } }), icons: { x: { body: path24('x') } } } });
    const out = path.join(tmp(), 'icons');
    await expect(buildIcons({ source, out, sets: ['alpha', 'gpl'], pinned: [] })).rejects.toThrow(/gpl: .*GPL-3\.0-or-later/);
  });

  it('stops the build for a body that fails the gate and for a missing set', async () => {
    const source = makeSource({ evil: { prefix: 'evil', info: info(), icons: { bad: { body: '<script/>' } } } });
    const out = path.join(tmp(), 'icons');
    await expect(buildIcons({ source, out, pinned: [] })).rejects.toThrow('evil:bad matches <script');
    await expect(buildIcons({ source, out: path.join(tmp(), 'icons'), sets: ['nope'], pinned: [] })).rejects.toThrow('nope: not in');
  });

  it('writes the pinned bodies in one file and lists them in the manifest', async () => {
    const source = makeSource();
    const out = path.join(tmp(), 'icons');
    await buildIcons({ source, out, pinned: ['alpha:a2', 'alpha:one'] });
    const manifest = read(out, 'manifest.json');
    expect(manifest.pin.names).toEqual(['alpha:a2', 'alpha:one']);
    const pins = read(out, `pin.${manifest.pin.f}.json`);
    expect(pins['alpha:a2']).toEqual({ b: path24('a2'), h: 24, w: 24 });
    expect(pins['alpha:one']).toEqual({ b: path24('a1'), h: 24, w: 24 });
  });

  it('stops the build for a pinned icon its set no longer has', async () => {
    const source = makeSource();
    await expect(buildIcons({ source, out: path.join(tmp(), 'icons'), pinned: ['alpha:gone'] })).rejects.toThrow('pinned icon alpha:gone');
  });

  it('keeps the curated list free of the excluded sets', () => {
    expect(CURATED_SETS.filter((p: string) => EXCLUDED_SETS.includes(p))).toEqual([]);
    expect(new Set(CURATED_SETS).size).toBe(CURATED_SETS.length);
  });
});

// A failed build used to reject while the other sets were still being written (CI on 1efc844: ENOTEMPTY when the
// caller cleaned up). The pool now settles only after every running task has finished.
describe('the build pool', () => {
  const tick = () => new Promise((r) => setTimeout(r, 5));

  it('rejects only after the tasks already running have finished, and starts no new one after a failure', async () => {
    const finished: number[] = [];
    const started: number[] = [];
    let settledWhileRunning = false;
    let running = 0;
    const p = runPool([0, 1, 2, 3, 4, 5, 6, 7], 3, async (n: number) => {
      started.push(n);
      running++;
      try {
        if (n === 0) throw new Error('first set is bad');
        for (let i = 0; i < 4; i++) await tick();
        finished.push(n);
        return n;
      } finally {
        running--;
      }
    });
    p.catch(() => { settledWhileRunning = running > 0; });
    await expect(p).rejects.toThrow('first set is bad');
    expect(settledWhileRunning).toBe(false);
    expect(running).toBe(0);
    // 1 and 2 were already running when 0 failed, so they finished; nothing after them was started
    expect(finished.sort()).toEqual([1, 2]);
    expect(started.sort()).toEqual([0, 1, 2]);
  });

  it('keeps results in order when nothing fails', async () => {
    expect(await runPool([3, 1, 2], 2, async (n: number) => { await tick(); return n * 10; })).toEqual([30, 10, 20]);
  });
});
