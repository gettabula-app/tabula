#!/usr/bin/env node
// What a release of this checkout declares, as JSON, for `POST /admin/releases` of the control plane (docs/migrations.md):
// the schema generations of its databases and the highest `minReader` any migration declares. It reads the migration lists
// of the code, so it cannot drift from what the build does.
//
//   npm run release-info
//   npm run release-info -- --version 2026.10.09-1      adds the label
import { parseArgs } from 'node:util';
import { CHAT_MIGRATIONS } from '../server/chat.mjs';
import { MIGRATIONS } from '../server/directory.mjs';
import { maxReaderOf } from '../server/schema.mjs';

const { values } = parseArgs({ options: { version: { type: 'string' } }, allowPositionals: false });
if (values.version !== undefined && !/^[A-Za-z0-9._-]{1,40}$/.test(values.version)) {
  console.error('--version must be 1 to 40 letters, digits, dots, dashes or underscores');
  process.exit(2);
}
const info = {
  ...(values.version ? { version: values.version } : {}),
  schema: { directory: MIGRATIONS.length, chat: CHAT_MIGRATIONS.length },
  maxReader: { directory: maxReaderOf(MIGRATIONS), chat: maxReaderOf(CHAT_MIGRATIONS) },
};
console.log(JSON.stringify(info));
