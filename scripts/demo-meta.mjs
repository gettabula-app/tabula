import fs from 'node:fs';
import path from 'node:path';

const out = path.resolve(process.cwd(), 'dist-demo');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'demo.json'), `${JSON.stringify({ base: '/demo/', ephemeral: true })}\n`);
