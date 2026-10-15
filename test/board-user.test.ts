import * as Y from 'yjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { validateChangedKeys } from '../server/sync-validate.mjs';
import { boardUser } from '../src/board-user';
import { Store } from '../src/store';
import { Builder, TEMPLATES } from '../src/templates';
import { createSyncGuard } from '../server/sync-guard.mjs';
import { isHiddenNow } from '../src/history';
import { isOwnAuthor } from '../src/identity';
import { ownerOptions } from '../src/ui/kanban-logic';
import type { AuthState } from '../src/auth';
import type { Obj } from '../src/types';

const DEVICE = { id: 'device-7d1f', name: 'Quick Otter', color: '#3366FF' };
const me = { user: { id: 'usr_acct123', name: 'Lea Brandt', role: 'member' } };

beforeEach(() => {
  const mem = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k),
  });
  localStorage.setItem('driftboard:user', JSON.stringify(DEVICE));
});

describe('boardUser', () => {
  it('uses the account id when signed in or offline, the guest id for guests, the device id in open mode', () => {
    expect(boardUser({ mode: 'signed-in', me } as unknown as AuthState)).toMatchObject({ id: 'usr_acct123', name: 'Lea Brandt' });
    expect(boardUser({ mode: 'offline', me } as unknown as AuthState)).toMatchObject({ id: 'usr_acct123' });
    expect(boardUser({ mode: 'guest', guest: { guestId: 'guest_9', name: 'Gus' } } as unknown as AuthState)).toMatchObject({ id: 'guest_9', guest: true });
    expect(boardUser({ mode: 'open' } as unknown as AuthState).id).toBe(DEVICE.id);
  });

  it('a signed-in user creating objects yields no forged_author violations, where the device id used to', () => {
    const create = (userId: string) => {
      const store = new Store(new Y.Doc());
      const builder = new Builder({ user: { id: userId }, store: { getMeta: () => ({ bodyFont: 'satoshi', headingFont: 'cabinet-grotesk' }) } }, 0, 0);
      TEMPLATES[0].build(builder);
      let z = 0;
      store.transact(() => { for (const o of builder.objs) store.create({ ...o, z: `a${(z++).toString(36)}` } as Obj); });
      const changes: { kind: string; key: string; value: unknown; isNew: boolean }[] = [];
      store.objects.forEach((m, key) => changes.push({ kind: 'object', key, value: m.toJSON(), isNew: true }));
      return changes;
    };
    const ctx = { writer: { id: me.user.id, name: me.user.name }, isBoardMember: () => true, canEditObject: () => true };
    const user = boardUser({ mode: 'signed-in', me } as unknown as AuthState);
    expect(validateChangedKeys(create(user.id), ctx)).toEqual({ ok: true });
    const old = validateChangedKeys(create(DEVICE.id), ctx) as { ok: boolean; violations?: { code: string }[] };
    expect(old.ok).toBe(false);
    expect(new Set(old.violations!.map((v) => v.code))).toEqual(new Set(['forged_author']));
  });
});

describe('objects made under the device id before the account id was stamped', () => {
  it('still count as the signed-in user\'s own, and nobody else\'s', () => {
    const user = boardUser({ mode: 'signed-in', me } as unknown as AuthState);
    expect(user.deviceId).toBe(DEVICE.id);
    expect(isOwnAuthor(user, DEVICE.id)).toBe(true);
    expect(isOwnAuthor(user, me.user.id)).toBe(true);
    expect(isOwnAuthor(user, 'someone-else')).toBe(false);
    expect(isOwnAuthor(user, '')).toBe(false);
    const note = { id: 'n', type: 'sticky', privateStep: 's1', createdBy: DEVICE.id } as unknown as Obj;
    expect(isHiddenNow(note, user, false)).toBe(false);
    expect(isHiddenNow(note, 'someone-else', false)).toBe(true);
  });
});

describe('the relay in its default mode', () => {
  it('counts a device-id author as forged_author in report mode and refuses nothing', () => {
    const guard = createSyncGuard({ mode: 'report' });
    const doc = new Y.Doc();
    const room = { kind: 'board', doc, held: null, sent: [] as Uint8Array[], broadcastUpdate: () => undefined };
    const ws = {};
    const ctx = { writer: { id: me.user.id, name: me.user.name }, isBoardMember: () => true, canEditObject: () => true };
    const sticky = new Y.Map<unknown>(Object.entries({ id: 'a', type: 'sticky', x: 1, y: 2, w: 3, h: 4, rotation: 0, z: 'a0', createdBy: DEVICE.id }));
    guard.run(room, ws, ctx, () => doc.transact(() => doc.getMap('objects').set('a', sticky), ws));
    expect(doc.getMap('objects').has('a')).toBe(true);
    expect(guard.stats()).toMatchObject({ rejected: 0, violations: 1, byCode: { forged_author: 1 } });
  });
});

describe('the card owner picker', () => {
  it('offers account ids, so picking a person passes the relay\'s board-member check (no forged_owner)', () => {
    const user = boardUser({ mode: 'signed-in', me } as unknown as AuthState);
    const options = ownerOptions({ id: user.id, name: user.name }, [{ id: 'usr_acct456', name: 'Ben' }], []);
    expect(options.map((o) => o.id)).toEqual([me.user.id, 'usr_acct456']);
    const members = new Set([me.user.id, 'usr_acct456']);
    const ctx = { writer: { id: me.user.id, name: me.user.name }, isBoardMember: (id: string) => members.has(id), canEditObject: () => true };
    for (const o of options) {
      const card = { id: 'c', type: 'card', x: 1, y: 2, w: 3, h: 4, rotation: 0, z: 'a0', createdBy: me.user.id, ownerId: o.id, ownerName: o.name, ownerKind: 'person' };
      expect(validateChangedKeys([{ kind: 'object', key: 'c', value: card, isNew: true }], ctx)).toEqual({ ok: true });
    }
    // the device id the picker used to offer is not a member
    const old = { id: 'c', type: 'card', x: 1, y: 2, w: 3, h: 4, rotation: 0, z: 'a0', createdBy: me.user.id, ownerId: DEVICE.id, ownerName: 'Lea', ownerKind: 'person' };
    const bad = validateChangedKeys([{ kind: 'object', key: 'c', value: old, isNew: true }], ctx) as { ok: boolean; violations?: { code: string }[] };
    expect(bad.violations!.map((v) => v.code)).toEqual(['forged_owner']);
  });
});
