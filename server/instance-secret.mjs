// Per-instance secrets live beside the SQLite files rather than in the database or logs.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const OAUTH_SECRET_FILE = 'oauth-secret';

/** Creates or reads the OAuth master secret only when OAuth is enabled. */
export function loadOAuthSecret(dataDir) {
  if (typeof dataDir !== 'string' || !dataDir) throw new TypeError('dataDir is required');
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, OAUTH_SECRET_FILE);
  try {
    fs.lstatSync(file);
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
    const temp = path.join(dataDir, `${OAUTH_SECRET_FILE}.tmp-${crypto.randomBytes(8).toString('hex')}`);
    let fd;
    try {
      fd = fs.openSync(temp, 'wx', 0o600);
      fs.writeFileSync(fd, crypto.randomBytes(32));
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      try {
        fs.linkSync(temp, file);
      } catch (linkError) {
        if (linkError?.code !== 'EEXIST') throw linkError;
      }
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      fs.rmSync(temp, { force: true });
    }
  }
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('The OAuth secret must be a regular file');
  if ((stat.mode & 0o777) !== 0o600) fs.chmodSync(file, 0o600);
  const secret = fs.readFileSync(file);
  if (secret.length !== 32) throw new Error('The OAuth secret must contain exactly 32 bytes');
  return secret;
}
