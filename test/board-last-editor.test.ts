import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDirectory } from '../server/directory.mjs';

const directories: ReturnType<typeof openDirectory>[] = [];

function boardFixture() {
  const directory = openDirectory(':memory:');
  directories.push(directory);
  const owner = directory.createUser({ email: 'owner@example.com', role: 'owner' })!;
  const board = directory.createBoard({ id: 'last-editor-board', ownerId: owner.id, title: 'Board' })!;
  return { directory, owner, board };
}

afterEach(() => {
  for (const directory of directories.splice(0)) directory.close();
  vi.restoreAllMocks();
});

describe('board last editor directory fields', () => {
  it('stores an agent editor by its token name and returns it from getBoard and listBoardsFor', () => {
    const { directory, owner, board } = boardFixture();
    const name = 'Anna<img src=x onerror=1>';

    directory.touchBoard(board.id, { editor: { by: name, kind: 'agent', at: 1_700_000_000_123 } });

    const expected = { lastEditedBy: name, lastEditedKind: 'agent', lastEditedAt: 1_700_000_000_123 };
    expect(directory.getBoard(board.id)).toMatchObject(expected);
    expect(directory.listBoardsFor(owner)[0]).toMatchObject(expected);
  });

  it('stores a person by user id, not by name, up to 128 characters of the id alphabet', () => {
    const { directory, owner, board } = boardFixture();
    const longId = 'a'.repeat(128);

    directory.touchBoard(board.id, { editor: { by: owner.id, kind: 'person', at: 1_700_000_000_123 } });
    expect(directory.getBoard(board.id)).toMatchObject({ lastEditedBy: owner.id, lastEditedKind: 'person', lastEditedAt: 1_700_000_000_123 });

    directory.touchBoard(board.id, { editor: { by: longId, kind: 'person', at: 1_700_000_000_124 } });
    expect(directory.getBoard(board.id)).toMatchObject({ lastEditedBy: longId, lastEditedKind: 'person', lastEditedAt: 1_700_000_000_124 });
  });

  it('strips control and format characters, caps at 40 code points, and defaults an invalid timestamp', () => {
    const { directory, board } = boardFixture();
    vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
    const name = `A\u0000n​na ${'😀'.repeat(60)}`;

    directory.touchBoard(board.id, { editor: { by: name, kind: 'agent', at: 1.5 } });

    const stored = directory.getBoard(board.id)!;
    expect(stored.lastEditedBy).toBe(`Anna ${'😀'.repeat(35)}`);
    expect([...stored.lastEditedBy!]).toHaveLength(40);
    expect(stored.lastEditedKind).toBe('agent');
    expect(stored.lastEditedAt).toBe(1_800_000_000_000);
  });

  it('ignores invalid or empty editors without clearing the previous editor and preserves it on an anonymous touch', () => {
    const { directory, owner, board } = boardFixture();
    const now = vi.spyOn(Date, 'now').mockReturnValue(10);
    const editor = { by: owner.id, kind: 'person', at: 15 };
    directory.touchBoard(board.id, { editor });

    now.mockReturnValue(20);
    directory.touchBoard(board.id, { editor: { by: 'Other', kind: 'bot', at: 20 } });
    expect(directory.getBoard(board.id)).toMatchObject({ lastEditedBy: owner.id, lastEditedKind: 'person', lastEditedAt: 15 });

    now.mockReturnValue(30);
    directory.touchBoard(board.id, { editor: { by: '\u0000​  \n', kind: 'agent', at: 30 } });
    expect(directory.getBoard(board.id)).toMatchObject({ lastEditedBy: owner.id, lastEditedKind: 'person', lastEditedAt: 15 });

    now.mockReturnValue(40);
    directory.touchBoard(board.id, {});
    expect(directory.getBoard(board.id)).toMatchObject({
      updatedAt: 40,
      lastEditedBy: owner.id,
      lastEditedKind: 'person',
      lastEditedAt: 15,
    });
  });

  it('ignores a person id outside the id alphabet, a non-string by, a non-object editor, and keeps the previous editor', () => {
    const { directory, owner, board } = boardFixture();
    const now = vi.spyOn(Date, 'now').mockReturnValue(10);
    directory.touchBoard(board.id, { editor: { by: owner.id, kind: 'person', at: 15 } });
    const kept = { lastEditedBy: owner.id, lastEditedKind: 'person', lastEditedAt: 15 };

    const refused = [
      { by: 'has space', kind: 'person', at: 20 },
      { by: 'a'.repeat(129), kind: 'person', at: 20 },
      { by: '', kind: 'person', at: 20 },
      { by: 'id\u0000', kind: 'person', at: 20 },
      { by: 'Ada.Lovelace', kind: 'person', at: 20 },
      { by: 'Ada Lovelace', kind: 'person', at: 20 },
      { by: 42, kind: 'person', at: 20 },
      { by: 42, kind: 'agent', at: 20 },
      { by: 'Other', kind: 'bot', at: 20 },
      { by: '\u0000​  \n', kind: 'agent', at: 30 },
    ];
    for (const editor of refused) {
      now.mockReturnValue(editor.at);
      directory.touchBoard(board.id, { editor });
      expect(directory.getBoard(board.id)).toMatchObject(kept);
    }

    for (const editor of [null, 'person', [{ by: 'Other', kind: 'person', at: 40 }]]) {
      directory.touchBoard(board.id, { editor: editor as never });
      expect(directory.getBoard(board.id)).toMatchObject(kept);
    }
  });

  it('maps an unknown stored editor kind to null', () => {
    const { directory, board } = boardFixture();
    directory.db.prepare('UPDATE boards SET last_edited_by = ?, last_edited_kind = ?, last_edited_at = ? WHERE id = ?')
      .run('Ada', 'guest', 15, board.id);

    expect(directory.getBoard(board.id)).toMatchObject({ lastEditedBy: 'Ada', lastEditedKind: null, lastEditedAt: 15 });
  });
});
