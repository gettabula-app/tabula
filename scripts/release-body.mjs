#!/usr/bin/env node
// The JSON body for `POST /admin/releases` of the control plane (docs/releasing.md, docs/migrations.md): the image by digest, the
// version label, the schema generations and the highest reader generation of this checkout. It is the logic of tabula-cloud's
// scripts/release.sh, so the release workflow does not need that repository.
//
//   node scripts/release-body.mjs --version v4 --digest sha256:<64 hex> [--image-repo registry.fly.io/tabula-app] [--security] [--notes "text"]
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

export const VERSION = /^[A-Za-z0-9._-]{1,40}$/;
export const DIGEST = /^sha256:[0-9a-f]{64}$/;
export const IMAGE_REPO = /^registry\.fly\.io\/[a-z0-9][a-z0-9-]*$/;
const validPair = (p) => p && Number.isSafeInteger(p.directory) && p.directory >= 0 && Number.isSafeInteger(p.chat) && p.chat >= 0;

/**
 * @param {{ version: string, digest: string, imageRepo?: string, security?: boolean, notes?: string }} input
 * @param {{ schema: { directory: number, chat: number }, maxReader: { directory: number, chat: number } }} info what `npm run release-info` prints
 */
export function releaseBody({ version, digest, imageRepo = 'registry.fly.io/tabula-app', security = false, notes }, info) {
  if (!VERSION.test(version ?? '')) throw new Error('invalid version: expected 1 to 40 letters, numbers, dots, underscores or hyphens');
  if (!DIGEST.test(digest ?? '')) throw new Error('invalid digest: expected sha256 followed by 64 lowercase hex characters');
  if (!IMAGE_REPO.test(imageRepo)) throw new Error('invalid image repository: expected registry.fly.io/<app>');
  if (!validPair(info?.schema) || !validPair(info?.maxReader)) throw new Error('release-info must return non-negative schema and maxReader generations');
  const body = { image: `${imageRepo}@${digest}`, version, schema: info.schema, maxReader: info.maxReader };
  if (notes !== undefined) body.notes = notes;
  if (security) body.security = true;
  return body;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { values } = parseArgs({
    options: { version: { type: 'string' }, digest: { type: 'string' }, 'image-repo': { type: 'string' }, security: { type: 'boolean' }, notes: { type: 'string' } },
    allowPositionals: false,
  });
  try {
    const [{ CHAT_MIGRATIONS }, { MIGRATIONS }, { maxReaderOf }] = await Promise.all([
      import('../server/chat.mjs'), import('../server/directory.mjs'), import('../server/schema.mjs'),
    ]);
    const info = { schema: { directory: MIGRATIONS.length, chat: CHAT_MIGRATIONS.length }, maxReader: { directory: maxReaderOf(MIGRATIONS), chat: maxReaderOf(CHAT_MIGRATIONS) } };
    process.stdout.write(JSON.stringify(releaseBody({ version: values.version, digest: values.digest, imageRepo: values['image-repo'], security: values.security, notes: values.notes }, info)));
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }
}
