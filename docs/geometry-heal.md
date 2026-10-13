# A position is never lost (geometry heal)

Reported by Johan on 2026-10-13: objects he had placed (a UML class, a link card) were somewhere else after a reload. The board file showed why: `uml-class`, `link` and `uml-initial` objects had **no `x`, `y` or `updatedAt` at all** (their other fields were intact), so the app drew them at the origin (0, 0), on top of each other. Older versions of the same board (Version history) had them at their placed positions, so something deleted exactly those three keys without writing a replacement.

## What is known

- The keys were deleted at the Yjs level: for each of x, y and updatedAt the last item in the object's map is a deleted item, with no item after it. `Store.update` cannot do it: it only deletes a key for an explicit `undefined` and always writes `updatedAt` after.
- The relay behind the board ran with sync validation off, so the relay did not revert anything (`server/sync-guard.mjs` is the one place where a server-side undo exists, and only in `enforce` mode).
- I could not reproduce it with drags, undo, redo, a second tab and reloads on the same stack (`test/object-positions-browser.test.ts` keeps those as regression tests). The loss is not tied to one object type: the three objects had been placed in different sessions.

## What the store does about it

`Store.noteLostGeometry` (src/store.ts) watches every change to an object. If an object that had a finite `x` and `y` a moment ago has lost one of them (and is not being removed), the position it had is written back after the transaction, with the origin `geometry-heal` (not an undo step, and not repeated). Connectors and groups never had a position of their own and are left alone; a read-only store (a viewer) writes nothing. Every client that sees the loss writes the same values, so they converge. The heal logs `Tabula: an object lost its position and it was put back` with the ids and the origin of the write that removed it, so the next occurrence names its cause.

It does not repair a board file that is already damaged (the position is gone from it): restore the objects from Version history, or move them again.

Tests: `test/geometry-heal.test.ts` (every object type, one key or all three, no undo step, no repeat, two clients converge, read-only) and `test/object-positions-browser.test.ts` (every type placed, dragged, reloaded twice; a position deleted underneath the app; undo and redo then a reload).
