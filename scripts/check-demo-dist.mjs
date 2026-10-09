#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import zlib from 'node:zlib';

const MiB = 1024 * 1024;
const EXPECTED_DEMO = { base: '/demo/', ephemeral: true };
const CHECK_ORIGIN = 'https://demo-check.invalid';

const fail = (message) => { throw new Error(message); };

function parseAttributes(source) {
  const attrs = new Map();
  const re = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let match;
  while ((match = re.exec(source))) attrs.set(match[1].toLowerCase(), match[2] ?? match[3] ?? match[4] ?? '');
  return attrs;
}

function tags(html, name) {
  const found = [];
  const re = new RegExp(`<${name}\\b([^>]*)>`, 'gi');
  let match;
  while ((match = re.exec(html))) found.push(parseAttributes(match[1]));
  return found;
}

function localUrl(value, baseUrl) {
  try {
    const url = new URL(value, baseUrl);
    return url.origin === CHECK_ORIGIN ? url : null;
  } catch {
    return null;
  }
}

function walk(dir, base = dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    const relative = path.relative(base, file).replaceAll(path.sep, '/');
    if (entry.isDirectory()) return [{ path: relative, dir: true }, ...walk(file, base)];
    if (entry.isFile()) return [{ path: relative, dir: false, file, bytes: fs.readFileSync(file) }];
    return [];
  });
}

function parseJson(file, description) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    fail(`${description} is missing or invalid JSON (${error.message})`);
  }
}

function checkIcons(root, entries) {
  const iconDir = path.join(root, 'icons');
  if (!fs.existsSync(iconDir) || !fs.statSync(iconDir).isDirectory()) fail('icons/ is missing');
  const iconFiles = entries.filter((entry) => entry.path.startsWith('icons/') && !entry.dir);
  for (const entry of iconFiles) {
    const relative = entry.path.slice('icons/'.length);
    if (relative === 'LICENSES.txt') continue;
    if (path.posix.extname(relative) !== '.json' || (entry.bytes[0] === 0x1f && entry.bytes[1] === 0x8b)) {
      fail(`icons/${relative} must be plain .json (LICENSES.txt is the only text-file exception)`);
    }
  }

  const manifest = parseJson(path.join(iconDir, 'manifest.json'), 'icons/manifest.json');
  if (!manifest || typeof manifest !== 'object' || !Array.isArray(manifest.sets)) fail('icons/manifest.json has no sets array');
  const referenced = new Set(['manifest.json']);
  for (const set of manifest.sets) {
    if (!set || typeof set !== 'object' || typeof set.p !== 'string' || typeof set.idx !== 'string' || !/^[a-f0-9]{8}$/.test(set.idx)) {
      fail('icons/manifest.json has an invalid set index reference');
    }
    const indexName = `i/${set.p}.${set.idx}.json`;
    const indexPath = path.join(iconDir, indexName);
    if (!fs.existsSync(indexPath)) fail(`icons manifest references missing file icons/${indexName}`);
    referenced.add(indexName);
    const index = parseJson(indexPath, `icons/${indexName}`);
    if (!index || typeof index !== 'object' || !Array.isArray(index.sh)) fail(`icons/${indexName} has no shard list`);
    for (let n = 0; n < index.sh.length; n++) {
      const hash = index.sh[n]?.[0];
      if (typeof hash !== 'string' || !/^[a-f0-9]{8}$/.test(hash)) fail(`icons/${indexName} has an invalid shard reference`);
      const shardName = `s/${set.p}.${n}.${hash}.json`;
      if (!fs.existsSync(path.join(iconDir, shardName))) fail(`icons manifest references missing file icons/${shardName}`);
      referenced.add(shardName);
    }
  }
  if (manifest.pin) {
    const hash = manifest.pin.f;
    if (typeof hash !== 'string' || !/^[a-f0-9]{8}$/.test(hash)) fail('icons/manifest.json has an invalid pin reference');
    const pinName = `pin.${hash}.json`;
    if (!fs.existsSync(path.join(iconDir, pinName))) fail(`icons manifest references missing file icons/${pinName}`);
    referenced.add(pinName);
  }

  for (const entry of iconFiles) {
    const relative = entry.path.slice('icons/'.length);
    if (relative === 'manifest.json' || relative === 'LICENSES.txt') continue;
    const indexMatch = /^i\/([a-z0-9]+(?:-[a-z0-9]+)*)\.([a-f0-9]{8})\.json$/.exec(relative);
    const shardMatch = /^s\/([a-z0-9]+(?:-[a-z0-9]+)*)\.(\d+)\.([a-f0-9]{8})\.json$/.exec(relative);
    const pinMatch = /^pin\.([a-f0-9]{8})\.json$/.exec(relative);
    const hash = indexMatch?.[2] ?? shardMatch?.[3] ?? pinMatch?.[1];
    if (!hash) fail(`icons/${relative} is not a manifest-style hashed JSON file`);
    const actual = crypto.createHash('sha256').update(entry.bytes).digest('hex').slice(0, 8);
    if (actual !== hash) fail(`icons/${relative} content hash is ${actual}, expected filename hash ${hash}`);
    if (!referenced.has(relative)) fail(`icons/${relative} is not referenced by icons/manifest.json`);
  }
}

/** Validate a built demo directory. Throws one actionable error at the first failed invariant. */
export function checkDemoDist(dir = path.resolve(process.cwd(), 'dist-demo')) {
  const root = path.resolve(dir);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) fail(`output directory does not exist: ${root}`);
  const indexPath = path.join(root, 'index.html');
  if (!fs.existsSync(indexPath)) fail('index.html is missing');
  const html = fs.readFileSync(indexPath, 'utf8');
  const allEntries = walk(root);

  for (const entry of allEntries) {
    if (entry.dir && path.posix.basename(entry.path) === 'docs') fail(`docs/ directory is forbidden (${entry.path})`);
    if (!entry.dir && path.posix.basename(entry.path) === 'sw.js') fail(`service worker is forbidden (${entry.path})`);
    if (!entry.dir && path.posix.basename(entry.path) === 'manifest.webmanifest') fail(`web app manifest is forbidden (${entry.path})`);
    if (!entry.dir && /\.(?:map|gz)$/i.test(entry.path)) fail(`source maps and gzip files are forbidden (${entry.path})`);
  }

  const tagRe = /<[a-z][^>]*>/gi;
  let tagMatch;
  while ((tagMatch = tagRe.exec(html))) {
    const attrs = parseAttributes(tagMatch[0].replace(/^<[a-z][^\s/>]*/i, '').replace(/\s*\/?\s*>$/, ''));
    for (const name of attrs.keys()) if (/^on/i.test(name)) fail(`inline event handler attribute ${name} is forbidden in index.html`);
  }
  for (const script of tags(html, 'script')) {
    if (!script.get('src')) fail('inline <script> is forbidden in index.html');
  }
  const csp = tags(html, 'meta').some((attrs) => attrs.get('http-equiv')?.toLowerCase() === 'content-security-policy' && attrs.has('content'));
  if (!csp) fail('Content-Security-Policy meta tag is missing from index.html');
  if (tags(html, 'link').some((attrs) => (attrs.get('rel') ?? '').toLowerCase().split(/\s+/).includes('manifest'))) {
    fail('<link rel="manifest"> is forbidden in index.html');
  }

  const htmlBase = new URL('/demo/', CHECK_ORIGIN);
  const bundleFiles = new Set([indexPath]);
  const urlAttrs = new Set(['href', 'src', 'action', 'poster', 'data']);
  const openTagRe = /<[a-z][^>]*>/gi;
  while ((tagMatch = openTagRe.exec(html))) {
    const attrs = parseAttributes(tagMatch[0].replace(/^<[a-z][^\s/>]*/i, '').replace(/\s*\/?\s*>$/, ''));
    for (const [name, value] of attrs) {
      if (!urlAttrs.has(name) && name !== 'srcset') continue;
      const values = name === 'srcset' ? value.split(',').map((part) => part.trim().split(/\s+/)[0]) : [value];
      for (const candidate of values) {
        if (!candidate) continue;
        const url = localUrl(candidate, htmlBase);
        if (!url) continue;
        if (!url.pathname.startsWith('/demo/')) fail(`local URL ${candidate} is outside /demo/`);
        if ((name === 'src' && tagMatch[0].toLowerCase().startsWith('<script')) ||
            (name === 'href' && tagMatch[0].toLowerCase().startsWith('<link') && (attrs.get('rel') ?? '').toLowerCase().split(/\s+/).includes('stylesheet'))) {
          const relative = decodeURIComponent(url.pathname.slice('/demo/'.length));
          const file = path.resolve(root, relative);
          if (file.startsWith(`${root}${path.sep}`) && fs.existsSync(file) && /\.(?:js|css)$/i.test(file)) bundleFiles.add(file);
        }
      }
    }
  }

  const demo = parseJson(path.join(root, 'demo.json'), 'demo.json');
  if (!demo || typeof demo !== 'object' || Array.isArray(demo) || Object.keys(demo).length !== 2 ||
      demo.base !== EXPECTED_DEMO.base || demo.ephemeral !== EXPECTED_DEMO.ephemeral) {
    fail('demo.json must equal {"base":"/demo/","ephemeral":true}');
  }

  checkIcons(root, allEntries);

  let rawTotal = 0;
  for (const entry of allEntries) {
    if (entry.dir) continue;
    rawTotal += entry.bytes.length;
    if (entry.bytes.length > MiB) fail(`${entry.path} is ${(entry.bytes.length / MiB).toFixed(2)} MiB raw; file limit is 1 MiB`);
  }
  if (rawTotal > 6 * MiB) fail(`distribution is ${(rawTotal / MiB).toFixed(2)} MiB raw; total limit is 6 MiB`);

  let entryGzip = 0;
  for (const file of bundleFiles) entryGzip += zlib.gzipSync(fs.readFileSync(file)).length;
  if (entryGzip > 1.5 * MiB) fail(`entry HTML, JavaScript and CSS gzip to ${(entryGzip / MiB).toFixed(2)} MiB; limit is 1.5 MiB`);
  return { files: allEntries.filter((entry) => !entry.dir).length, rawBytes: rawTotal, entryGzipBytes: entryGzip };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const result = checkDemoDist(process.argv[2] ? path.resolve(process.argv[2]) : undefined);
    console.log(`Demo distribution check passed: ${result.files} files, ${(result.rawBytes / MiB).toFixed(2)} MiB raw`);
  } catch (error) {
    console.error(`Demo distribution check failed: ${error.message}`);
    process.exitCode = 1;
  }
}
