import { describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import {
  BackupError, OVERHEAD, createKeyring, createScrubber, deriveKeys, formatManifestName, objectIdOf, parseManifestName, pruneManifests,
  seal, unseal, validateRelPath,
} from '../server/backup.mjs';

// docs/backups.md. The sealing format, the keys derived from the master key, the manifest paths and the retention rules.

const MASTER = crypto.randomBytes(32);
const OTHER = crypto.randomBytes(32);
const keys = deriveKeys(MASTER);
const ring = createKeyring([MASTER]);
const failure = (fn: () => unknown): BackupError => {
  try {
    fn();
  } catch (err) {
    return err as BackupError;
  }
  throw new Error('expected a BackupError');
};
const hkdf = (info: string) => Buffer.from(crypto.hkdfSync('sha256', MASTER, Buffer.alloc(0), info, 32));

describe('keys', () => {
  it('are HKDF-SHA256 of the master key with the documented labels', () => {
    expect(keys.encKey.equals(hkdf('tabula-backup/enc/v1'))).toBe(true);
    expect(keys.nameKey.equals(hkdf('tabula-backup/name/v1'))).toBe(true);
    expect(keys.keyId).toBe(hkdf('tabula-backup/keyid/v1').toString('hex').slice(0, 8));
    expect(keys.keyIdBytes.toString('hex')).toBe(keys.keyId);
    expect(keys.encKey.equals(keys.nameKey)).toBe(false);
    expect(keys.encKey.equals(MASTER)).toBe(false);
  });

  it('give the same key id for the same key and another one for another key', () => {
    expect(deriveKeys(Buffer.from(MASTER)).keyId).toBe(keys.keyId);
    expect(deriveKeys(OTHER).keyId).not.toBe(keys.keyId);
    expect(keys.keyId).toMatch(/^[0-9a-f]{8}$/);
  });

  it('refuse a master key that is not 32 bytes', () => {
    expect(failure(() => deriveKeys(Buffer.alloc(16)))).toBeInstanceOf(BackupError);
    expect(() => deriveKeys('x' as never)).toThrow(BackupError);
  });

  it('name a file by a keyed hash: the same file gets one name per key, and nobody else can compute it', () => {
    const data = Buffer.from('some board');
    const id = objectIdOf(data, keys);
    expect(id).toBe(crypto.createHmac('sha256', hkdf('tabula-backup/name/v1')).update(data).digest('hex'));
    expect(id).not.toBe(crypto.createHash('sha256').update(data).digest('hex'));
    expect(objectIdOf(data, deriveKeys(OTHER))).not.toBe(id);
    expect(objectIdOf(Buffer.from('some board!'), keys)).not.toBe(id);
  });
});

describe('sealing', () => {
  const NAME = 'obj:abc';

  it('lays out version, key id, nonce, ciphertext and tag', () => {
    const plain = Buffer.from('hello backup');
    const sealed = seal(plain, NAME, keys);
    expect(sealed.length).toBe(plain.length + OVERHEAD);
    expect(OVERHEAD).toBe(33);
    expect(sealed[0]).toBe(1);
    expect(sealed.subarray(1, 5).toString('hex')).toBe(keys.keyId);
    expect(sealed.subarray(17, 17 + plain.length).equals(plain)).toBe(false);
    expect(sealed.includes(plain)).toBe(false);
  });

  it('is AES-256-GCM with the header and the name as additional data', () => {
    const plain = Buffer.from('independent check');
    const sealed = seal(plain, NAME, keys);
    const decipher = crypto.createDecipheriv('aes-256-gcm', hkdf('tabula-backup/enc/v1'), sealed.subarray(5, 17));
    decipher.setAAD(Buffer.concat([sealed.subarray(0, 5), Buffer.from(NAME)]));
    decipher.setAuthTag(sealed.subarray(sealed.length - 16));
    expect(Buffer.concat([decipher.update(sealed.subarray(17, sealed.length - 16)), decipher.final()]).equals(plain)).toBe(true);
  });

  it.each([0, 1, 100, 1024 * 1024 - 1, 1024 * 1024, 1024 * 1024 + 1, 2_500_000])('round trips %i bytes', (n) => {
    const plain = crypto.randomBytes(n);
    const sealed = seal(plain, NAME, keys);
    const opened = unseal(sealed, NAME, ring);
    expect(opened.plaintext.equals(plain)).toBe(true);
    expect(opened.keys.keyId).toBe(keys.keyId);
  });

  it('uses a fresh nonce every time', () => {
    const plain = Buffer.from('same');
    const a = seal(plain, NAME, keys);
    const b = seal(plain, NAME, keys);
    expect(a.subarray(5, 17).equals(b.subarray(5, 17))).toBe(false);
    expect(a.equals(b)).toBe(false);
  });

  describe('tampering', () => {
    const plain = crypto.randomBytes(3000);
    const sealed = seal(plain, NAME, keys);
    const flip = (at: number, mask = 1) => {
      const copy = Buffer.from(sealed);
      copy[at] ^= mask;
      return copy;
    };

    it('a flipped bit in the ciphertext is caught', () => {
      expect(failure(() => unseal(flip(100), NAME, ring))).toMatchObject({ name: 'BackupError', code: 'tamper' });
    });

    it('so is one in the nonce, the tag and the first and last byte of the ciphertext', () => {
      for (const at of [5, 16, 17, sealed.length - 17, sealed.length - 16, sealed.length - 1]) {
        expect(failure(() => unseal(flip(at, 0x80), NAME, ring)).code).toBe('tamper');
      }
    });

    it('a changed version byte is an unknown format', () => {
      expect(failure(() => unseal(flip(0, 2), NAME, ring)).code).toBe('bad_format');
    });

    it('a changed key id is an unknown key, not a guess', () => {
      expect(failure(() => unseal(flip(2), NAME, ring)).code).toBe('unknown_key');
    });

    it('an object under another name (a swap) is caught by the additional data', () => {
      expect(failure(() => unseal(sealed, 'obj:def', ring)).code).toBe('tamper');
      expect(failure(() => unseal(sealed, 'manifest:abc', ring)).code).toBe('tamper');
      expect(failure(() => unseal(sealed, 'obj:ab', ring)).code).toBe('tamper');
    });

    it('a manifest renamed to another timestamp is caught', () => {
      const manifest = seal(Buffer.from('{}'), 'manifest:20261008T193000Z.json.enc', keys);
      expect(unseal(manifest, 'manifest:20261008T193000Z.json.enc', ring).plaintext.toString()).toBe('{}');
      expect(failure(() => unseal(manifest, 'manifest:20261008T203000Z.json.enc', ring)).code).toBe('tamper');
    });

    it('truncation, at any length, is caught', () => {
      expect(failure(() => unseal(sealed.subarray(0, sealed.length - 1), NAME, ring)).code).toBe('tamper');
      expect(failure(() => unseal(sealed.subarray(0, sealed.length - 17), NAME, ring)).code).toBe('tamper');
      expect(failure(() => unseal(sealed.subarray(0, OVERHEAD), NAME, ring)).code).toBe('tamper');
      expect(failure(() => unseal(sealed.subarray(0, OVERHEAD - 1), NAME, ring)).code).toBe('bad_format');
      expect(failure(() => unseal(sealed.subarray(0, 10), NAME, ring)).code).toBe('bad_format');
      expect(failure(() => unseal(Buffer.alloc(0), NAME, ring)).code).toBe('bad_format');
    });

    it('appended bytes are caught', () => {
      expect(failure(() => unseal(Buffer.concat([sealed, Buffer.from([0])]), NAME, ring)).code).toBe('tamper');
    });

    it('a different key is an unknown key', () => {
      expect(failure(() => unseal(sealed, NAME, createKeyring([OTHER]))).code).toBe('unknown_key');
    });

    it('the message holds neither key, name nor contents', () => {
      const err = failure(() => unseal(flip(100), NAME, ring));
      for (const secret of [MASTER.toString('hex'), MASTER.toString('base64'), keys.encKey.toString('hex'), NAME]) expect(err.message).not.toContain(secret);
    });
  });

  describe('key rotation', () => {
    const rotated = createKeyring([OTHER, MASTER]);

    it('reads what an earlier key sealed and writes with the new one', () => {
      const old = seal(Buffer.from('old data'), NAME, keys);
      const opened = unseal(old, NAME, rotated);
      expect(opened.plaintext.toString()).toBe('old data');
      expect(opened.keys.keyId).toBe(keys.keyId);
      expect(rotated.current.keyId).toBe(deriveKeys(OTHER).keyId);
      expect(seal(Buffer.from('new'), NAME, rotated.current).subarray(1, 5).toString('hex')).toBe(deriveKeys(OTHER).keyId);
    });

    it('does not read what a key it never had sealed', () => {
      const foreign = seal(Buffer.from('x'), NAME, deriveKeys(crypto.randomBytes(32)));
      expect(failure(() => unseal(foreign, NAME, rotated)).code).toBe('unknown_key');
    });
  });
});

describe('paths in a manifest', () => {
  it.each([
    'directory.sqlite', 'abc.yjs', 'abc~comments.yjs', 'history/abc/index.json', 'history/abc/0123456789abcdef.yjs.gz', 'a/b.c/d-e_f', '..x', 'x..', 'a/.hidden',
  ])('accepts %s', (p) => {
    expect(validateRelPath(p)).toBe(p);
  });

  it.each([
    ['..'], ['../x'], ['a/../b'], ['a/..'], ['/etc/passwd'], ['/'], ['a\\b'], ['..\\x'], ['C:/x'], ['c:\\x'], ['./x'], ['a/./b'], ['a//b'], ['a/'], [''],
    ['a\0b'], ['a\nb'], ['x'.repeat(301)], [null], [undefined], [3], [{}], [['a']],
  ])('refuses %j', (p) => {
    expect(failure(() => validateRelPath(p))).toMatchObject({ name: 'BackupError', code: 'invalid_path' });
  });
});

describe('manifest names', () => {
  it('are UTC timestamps that sort by time', () => {
    const at = Date.UTC(2026, 9, 8, 19, 30, 0);
    expect(formatManifestName(at)).toBe('20261008T193000Z.json.enc');
    expect(parseManifestName('20261008T193000Z.json.enc')).toBe(at);
    expect(formatManifestName(at + 1999)).toBe('20261008T193001Z.json.enc');
    expect(formatManifestName(Date.UTC(2026, 11, 31, 23, 59, 59)) > formatManifestName(Date.UTC(2026, 11, 31, 23, 59, 58))).toBe(true);
  });

  it.each([['20261308T193000Z.json.enc'], ['20261008T253000Z.json.enc'], ['20260230T000000Z.json.enc'], ['20261008T193000.json.enc'], ['x/20261008T193000Z.json.enc'], ['20261008T193000Z.json'], ['']])(
    'does not accept %j',
    (name) => {
      expect(parseManifestName(name)).toBeNull();
    },
  );
});

describe('which manifests are kept', () => {
  const NOW = Date.UTC(2026, 9, 8, 19, 30, 0);
  const names = (...stamps: string[]) => stamps.map((s) => `${s}.json.enc`);
  const ALL = names(
    '20261008T193000Z', '20261008T191500Z', '20261008T190500Z', '20261008T184500Z', '20261008T181000Z',
    '20261007T121500Z', '20261007T120000Z', '20261006T230000Z', '20261006T100000Z', '20261005T100000Z', '20261005T090000Z',
    '20260909T100000Z', '20260908T100000Z', '20260701T000000Z',
  );
  const run = (list: string[], hourly: number, daily: number, now = NOW) => {
    const { keep, drop } = pruneManifests(list, now, { keepHourlyHours: hourly, keepDailyDays: daily });
    return { keep: [...keep].sort().reverse(), drop: drop.sort().reverse() };
  };

  it('keeps the newest per hour for 48 hours, the newest per day for 30 days, and the newest overall', () => {
    const { keep } = run(ALL, 48, 30);
    expect(keep).toEqual(names('20261008T193000Z', '20261008T184500Z', '20261007T121500Z', '20261006T230000Z', '20261005T100000Z', '20260909T100000Z'));
  });

  it('drops the rest, and keep and drop together are everything', () => {
    const { keep, drop } = run(ALL, 48, 30);
    expect([...keep, ...drop].sort()).toEqual([...ALL].sort());
    expect(drop).toContain('20261008T191500Z.json.enc');
    expect(drop).toContain('20260908T100000Z.json.enc');
    expect(drop).toContain('20260701T000000Z.json.enc');
  });

  it('the basic tier: no hourly points, a week of days', () => {
    expect(run(ALL, 0, 7).keep).toEqual(names('20261008T193000Z', '20261007T121500Z', '20261006T230000Z', '20261005T100000Z'));
  });

  it('with neither window only the newest is kept', () => {
    expect(run(ALL, 0, 0).keep).toEqual(names('20261008T193000Z'));
  });

  it('hourly points only', () => {
    expect(run(ALL, 3, 0).keep).toEqual(names('20261008T193000Z', '20261008T184500Z'));
  });

  it('always keeps the newest, however old it is', () => {
    const old = names('20250101T000000Z');
    expect(run(old, 48, 30).keep).toEqual(old);
    expect(run(old, 0, 0).keep).toEqual(old);
    expect(run([], 48, 30)).toEqual({ keep: [], drop: [] });
  });

  it('puts the edges where it says: exactly 48 hours old is still hourly, a second older is not', () => {
    const edge = formatManifestName(NOW - 48 * 3_600_000);
    const past = formatManifestName(NOW - 48 * 3_600_000 - 1000);
    const newest = formatManifestName(NOW);
    expect(run([newest, edge], 48, 0).keep).toContain(edge);
    expect(run([newest, past], 48, 0).keep).not.toContain(past);
    const dayEdge = formatManifestName(NOW - 30 * 86_400_000);
    expect(run([newest, dayEdge], 0, 30).keep).toContain(dayEdge);
    expect(run([newest, formatManifestName(NOW - 30 * 86_400_000 - 1000)], 0, 30).keep).toHaveLength(1);
  });

  it('treats a manifest from the future as brand new', () => {
    const future = formatManifestName(NOW + 3_600_000);
    const { keep } = run([future, ...ALL], 48, 30);
    expect(keep).toContain(future);
    expect(keep).toContain('20261008T193000Z.json.enc');
  });

  it('leaves names that are not manifests alone', () => {
    const { keep, drop } = run(['notes.txt', '20261008T191500Z.json.enc', '20261008T193000Z.json.enc'], 48, 30);
    expect(keep).toEqual(names('20261008T193000Z'));
    expect(drop).toEqual(names('20261008T191500Z'));
  });

  it('thins a long history to the right number of points', () => {
    const list: string[] = [];
    for (let at = NOW - 40 * 86_400_000; at <= NOW; at += 20 * 60_000) list.push(formatManifestName(at));
    const { keep } = pruneManifests(list, NOW, { keepHourlyHours: 48, keepDailyDays: 30 });
    const kept = [...keep];
    const hours = new Set(kept.filter((n) => NOW - parseManifestName(n)! <= 48 * 3_600_000).map((n) => Math.floor(parseManifestName(n)! / 3_600_000)));
    expect(hours.size).toBeGreaterThanOrEqual(48);
    expect(hours.size).toBeLessThanOrEqual(49);
    const days = new Set(kept.filter((n) => NOW - parseManifestName(n)! <= 30 * 86_400_000).map((n) => Math.floor(parseManifestName(n)! / 86_400_000)));
    expect(days.size).toBeGreaterThanOrEqual(30);
    expect(kept.length).toBeLessThan(48 + 32 + 3);
    expect(kept.filter((n) => NOW - parseManifestName(n)! > 30 * 86_400_000)).toEqual([]);
  });
});

describe('the scrubber', () => {
  const scrub = createScrubber(['SECRET-VALUE-123', 'AKIAACCESSKEY0001', 'abcd', 'xy']);

  it('removes the literals it is given, every time they occur', () => {
    expect(scrub('a SECRET-VALUE-123 b SECRET-VALUE-123 AKIAACCESSKEY0001')).toBe('a [hidden] b [hidden] [hidden]');
  });

  it('ignores literals too short to mean anything', () => {
    expect(scrub('xy abc')).toBe('xy abc');
  });

  it('removes signatures, credentials, authorization headers and URL credentials', () => {
    const sig = 'a'.repeat(64);
    const text = scrub(`https://user:pw@host/p?X-Amz-Signature=${sig}&X-Amz-Credential=AKIA%2F2026%2Fauto and Authorization: AWS4-HMAC-SHA256 Credential=AKIAX/20261008/auto/s3/aws4_request, SignedHeaders=host, Signature=${sig}`);
    expect(text).not.toContain(sig);
    expect(text).not.toContain('user:pw');
    expect(text).not.toContain('AKIAX');
    expect(text).not.toContain('2026%2Fauto');
  });

  it('flattens control characters so a message stays on one line', () => {
    expect(scrub('a\nb\r\nc\u0000d')).toBe('a b c d');
  });
});
