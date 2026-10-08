import { describe, expect, it, vi } from 'vitest';
import type { Me } from '../src/api';
import type { AuthState } from '../src/auth';
import type { CustomTemplate } from '../src/custom-templates';
import { builtinToCustom, duplicateTemplate, exportTemplateFile, parseTemplateFile, withoutSharing } from '../src/template-file';
import { OFFLINE_MESSAGE } from '../src/template-server';
import {
  GUEST_MESSAGE, PERSONAL_LABEL, WORKSPACE_LABEL, accountId, choiceFor, choiceValue, mayChange, saveBlocked, scopeLabel, shareChoices, shareHint, splitMine,
} from '../src/template-share';
import { UPLOAD_OFFER_KEY, forUpload, markOfferShown, offerWasShown, shouldOfferUpload, uploadBrowserTemplates } from '../src/template-upload';
import { TEMPLATES } from '../src/templates';
import { validateTemplate } from '../src/template-store';
import type { BaseObj } from '../src/types';

const sticky = (id: string): BaseObj => ({ id, type: 'sticky', x: 0, y: 0, w: 100, h: 80, rotation: 0, z: '1', text: id });
const template = (id: string, extra: Partial<CustomTemplate> = {}): CustomTemplate => ({
  id, version: 1, name: `Template ${id}`, category: 'Custom', description: '', createdBy: 'u1', createdAt: Number(id.replace(/\D/g, '')) || 1, updatedAt: 1,
  content: { objects: [sticky('o1')], steps: [], bounds: { x: 0, y: 0, w: 100, h: 80 } }, ...extra,
});
const me = (role: Me['user']['role'], teams: Me['teams'] = [{ id: 't1', name: 'Design', role: 'member' }]): Me => ({
  user: { id: 'u1', email: 'ana@example.com', name: 'Ana', role }, teams,
});

describe('sharing choices', () => {
  it('offers Only me and the person\'s teams to a member', () => {
    const choices = shareChoices(me('member', [{ id: 't1', name: 'Design', role: 'admin' }, { id: 't2', name: 'Ops', role: 'member' }]));
    expect(choices.map((c) => [c.value, c.label, c.scope, c.teamId])).toEqual([
      ['personal', PERSONAL_LABEL, 'personal', null],
      ['team:t1', 'Design', 'team', 't1'],
      ['team:t2', 'Ops', 'team', 't2'],
    ]);
  });

  it('adds Everyone in the workspace for workspace owners and admins only', () => {
    for (const role of ['owner', 'admin'] as const) {
      expect(shareChoices(me(role)).at(-1)).toEqual({ value: 'workspace', label: WORKSPACE_LABEL, scope: 'workspace', teamId: null });
    }
    for (const role of ['member', 'guest'] as const) expect(shareChoices(me(role)).some((c) => c.scope === 'workspace')).toBe(false);
  });

  it('keeps the team of a template that an admin edits without belonging to it', () => {
    const choices = shareChoices(me('admin', []), { scope: 'team', teamId: 'other', teamName: 'Elsewhere' });
    expect(choices.map((c) => c.label)).toEqual([PERSONAL_LABEL, 'Elsewhere', WORKSPACE_LABEL]);
    expect(shareChoices(me('member'), { scope: 'team', teamId: 't1', teamName: 'Design' })).toHaveLength(2);
  });

  it('finds the choice that matches a template, and falls back to Only me', () => {
    const choices = shareChoices(me('admin'));
    expect(choiceValue({})).toBe('personal');
    expect(choiceValue({ scope: 'personal', teamId: null })).toBe('personal');
    expect(choiceValue({ scope: 'team', teamId: 't1' })).toBe('team:t1');
    expect(choiceValue({ scope: 'workspace', teamId: null })).toBe('workspace');
    expect(choiceFor(choices, 'team:t1').teamId).toBe('t1');
    expect(choiceFor(choices, 'team:gone')).toBe(choices[0]);
    expect(choiceFor(choices, '')).toBe(choices[0]);
  });

  it('says what each choice means', () => {
    expect(shareHint({ scope: 'personal' })).toMatch(/Only you/);
    expect(shareHint({ scope: 'team' })).toMatch(/team/);
    expect(shareHint({ scope: 'workspace' })).toMatch(/owners and admins/);
  });
});

describe('cards and groups', () => {
  it('labels a card with who it is shared with', () => {
    expect(scopeLabel(template('a'), 'u1')).toBe(PERSONAL_LABEL);
    expect(scopeLabel(template('a'), null)).toBe(PERSONAL_LABEL);
    expect(scopeLabel(template('a', { scope: 'team', teamName: 'Design' }), 'u1')).toBe('Design');
    expect(scopeLabel(template('a', { scope: 'team' }), 'u1')).toBe('Team');
    expect(scopeLabel(template('a', { scope: 'workspace' }), 'u1')).toBe('Workspace');
    expect(scopeLabel(template('a', { scope: 'personal', createdBy: '' }), 'u1')).toBe('Owner removed');
  });

  it('splits the list into mine and shared with me in accounts mode, and keeps everything mine without accounts', () => {
    const mine = template('a', { scope: 'team', teamName: 'Design' });
    const theirs = template('b', { createdBy: 'u2', scope: 'workspace' });
    const orphan = template('c', { createdBy: '', scope: 'personal' });
    expect(splitMine([mine, theirs, orphan], 'u1')).toEqual({ mine: [mine], shared: [theirs, orphan] });
    expect(splitMine([mine, theirs], null)).toEqual({ mine: [mine, theirs], shared: [] });
  });

  it('lets a person change a template unless the server said they may not', () => {
    expect(mayChange({})).toBe(true);
    expect(mayChange({ canChange: true })).toBe(true);
    expect(mayChange({ canChange: false })).toBe(false);
  });

  it('knows the account id only in accounts mode', () => {
    expect(accountId({ mode: 'signed-in', me: me('member') })).toBe('u1');
    expect(accountId({ mode: 'offline', me: me('member') })).toBe('u1');
    expect(accountId({ mode: 'offline', me: null })).toBeNull();
    for (const mode of ['unknown', 'open', 'signed-out'] as const) expect(accountId({ mode })).toBeNull();
  });
});

describe('saving is blocked', () => {
  it('while offline and for guests, with a message', () => {
    expect(saveBlocked({ mode: 'offline', me: me('member') })).toBe(OFFLINE_MESSAGE);
    expect(saveBlocked({ mode: 'signed-in', me: me('guest') })).toBe(GUEST_MESSAGE);
    for (const state of [{ mode: 'signed-in', me: me('member') }, { mode: 'signed-in', me: me('admin') }, { mode: 'open' }] as AuthState[]) {
      expect(saveBlocked(state)).toBeNull();
    }
  });
});

describe('template files', () => {
  const shared = template('a', { scope: 'workspace', teamId: null, ownerName: 'Bo', canChange: false });

  it('are written without who the template is shared with', () => {
    const file = JSON.parse(exportTemplateFile(shared));
    for (const key of ['scope', 'teamId', 'teamName', 'ownerName', 'canChange']) expect(file.template).not.toHaveProperty(key);
    expect(file.template.name).toBe('Template a');
  });

  it('are read as a new personal template, whatever the file says about sharing', () => {
    const text = JSON.stringify({ format: 'tabula-template', version: 1, template: shared });
    const t = parseTemplateFile(text, 'u9');
    for (const key of ['scope', 'teamId', 'teamName', 'ownerName', 'canChange'] as const) expect(t).not.toHaveProperty(key);
    expect(t.createdBy).toBe('u9');
  });

  it('are copied without it too', () => {
    expect(duplicateTemplate(shared, 'u2')).not.toHaveProperty('scope');
    expect(withoutSharing(shared)).toEqual(template('a'));
  });

  it('keep the sharing a template has when the store checks it', () => {
    expect(validateTemplate(shared)).toEqual(shared);
    expect(validateTemplate({ ...shared, scope: 'galaxy' })).not.toHaveProperty('scope');
    expect(validateTemplate({ ...shared, teamName: 5, canChange: 'yes' })).not.toHaveProperty('canChange');
    expect(validateTemplate(template('a'))).toEqual(template('a'));
  });
});

describe('the upload offer', () => {
  const storage = () => {
    const rows = new Map<string, string>();
    return { rows, getItem: (k: string) => rows.get(k) ?? null, setItem: (k: string, v: string) => void rows.set(k, v) };
  };

  it('is made once per browser, remembered under a driftboard: key', () => {
    expect(UPLOAD_OFFER_KEY.startsWith('driftboard:')).toBe(true);
    const s = storage();
    expect(offerWasShown(s)).toBe(false);
    markOfferShown(s);
    expect(offerWasShown(s)).toBe(true);
    expect(s.rows.get(UPLOAD_OFFER_KEY)).toBe('1');
  });

  it('is not made where it cannot be remembered', () => {
    expect(offerWasShown(null)).toBe(true);
    const blocked = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
    expect(offerWasShown(blocked)).toBe(true);
    expect(() => markOfferShown(blocked)).not.toThrow();
  });

  it('is made only to someone signed in, who was not asked yet and has templates here', () => {
    expect(shouldOfferUpload('signed-in', false, 2)).toBe(true);
    expect(shouldOfferUpload('signed-in', true, 2)).toBe(false);
    expect(shouldOfferUpload('signed-in', false, 0)).toBe(false);
    for (const mode of ['unknown', 'open', 'signed-out', 'offline'] as const) expect(shouldOfferUpload(mode, false, 2)).toBe(false);
  });

  it('makes a personal copy with a new id, a category the server knows and nothing shared', () => {
    const t = forUpload(template('a', { category: 'Whatever you like', scope: 'team', teamId: 't1', canChange: false }));
    expect(t).toMatchObject({ name: 'Template a', category: 'Custom', scope: 'personal', teamId: null });
    expect(t.id).not.toBe('a');
    expect(t).not.toHaveProperty('canChange');
    expect(forUpload(template('a', { category: 'Risk' })).category).toBe('Risk');
    expect(forUpload(template('a')).id).not.toBe(forUpload(template('a')).id);
  });

  it('uploads the templates oldest first and leaves the browser\'s own alone', async () => {
    const mine = [template('3'), template('1', { category: 'Risk' }), template('2')];
    const list = vi.fn<() => Promise<CustomTemplate[]>>(async () => mine);
    const put = vi.fn<(t: CustomTemplate) => Promise<CustomTemplate>>(async (t) => t);
    const progress: [number, number][] = [];
    const result = await uploadBrowserTemplates({ list }, { put }, (done, total) => progress.push([done, total]));
    expect(result).toEqual({ uploaded: 3, failed: [] });
    expect(put.mock.calls.map(([t]) => t.name)).toEqual(['Template 1', 'Template 2', 'Template 3']);
    expect(put.mock.calls.every(([t]) => t.scope === 'personal' && t.teamId === null)).toBe(true);
    expect(put.mock.calls[0][0].category).toBe('Risk');
    expect(progress).toEqual([[1, 3], [2, 3], [3, 3]]);
    expect(mine.map((t) => t.id)).toEqual(['3', '1', '2']);
  });

  it('reports a template the server refuses and goes on with the rest', async () => {
    const list = async () => [template('1'), template('2'), template('3')];
    const put = vi.fn<(t: CustomTemplate) => Promise<CustomTemplate>>(async (t) => {
      if (t.name === 'Template 2') throw new Error('Object 1 has an SVG body that is not allowed');
      return t;
    });
    const result = await uploadBrowserTemplates({ list }, { put });
    expect(result.uploaded).toBe(2);
    expect(result.failed).toEqual([{ name: 'Template 2', message: 'Object 1 has an SVG body that is not allowed' }]);
  });

  it('uploads nothing when there is nothing in the browser', async () => {
    const put = vi.fn<(t: CustomTemplate) => Promise<CustomTemplate>>(async (t) => t);
    expect(await uploadBrowserTemplates({ list: async () => [] }, { put })).toEqual({ uploaded: 0, failed: [] });
    expect(put).not.toHaveBeenCalled();
  });

  it('can upload a template made from every built-in one', () => {
    for (const def of TEMPLATES) expect(forUpload(builtinToCustom(def, 'u1')).scope).toBe('personal');
  });
});
