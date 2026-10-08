# Polls

A facilitated question with a fixed list of answers. A poll is a session step, so it reuses the session bar, the timer and the reveal from dot voting. It works offline and syncs like the rest of the board. A **quick poll** button starts one with no template, as the dot vote button does.

Status: spec for review. Nothing is built yet.

## Summary

- A poll is a question with 2–10 options, single or multiple choice, anonymous or named.
- It is a new step mode, `'poll'`. The step runs in the session bar with its timer, Prev/Next and Finish.
- Each person has one answer set. They can change it until the poll closes (the flow leaves its step, or the session ends).
- Results stay hidden until the facilitator reveals them. Reveal is per poll.
- Results: a ranked list in a card above the session bar, copyable as Markdown, and optionally added to the board as a sticky.
- Everything lives in the board's Yjs document, so it works offline, syncs, and travels in `.drift` with no extra work.

## Decisions and why

- **A new step mode, not dot votes.** A `Vote` points at a board object (`itemId`). A poll answer points at an option, and multiple choice replaces an answer set rather than adding dots. Reusing `Vote` would make its type lie and push poll branches into `handleClick`, `refreshVotes` and the overlay. A separate map leaves dot voting untouched.
- **Stored in the board document, not the comments document.** Owners and editors can write the board room. Viewers and commenters cannot, and the relay already drops their board writes. That is the rule a poll needs, so no relay change is required. Commenters answering would need answers in the comments room (see open questions).
- **Poll reveal does not use `flow.reveal`.** `isHidden` hides a private note while `flow.reveal` is false, and `flow.reveal()` strips `privateStep` from every object. Setting the flag alone would expose private notes from an earlier private-writing step that are still hidden. A poll has its own `revealed` flag instead.
- **Definitions live in their own map, not only on the step.** Quick steps are removed at Finish. If the question and options lived only on the step, the answers would be orphaned at Finish. A separate `polls` map lets a quick poll's results outlive the session until someone clears them, as dot results do.
- **The ranked list sits in a card above the bar, not inside the bar.** The bar is one line and already cramped on a phone, and a popover closes whenever the bar re-renders. The card is a stable target for radio buttons and checkboxes. The bar keeps the buttons (reveal, copy, sticky, clear) and the after-session results block.
- **No schema version bump.** New optional fields and two new root maps are backward compatible. Older clients will show a poll step without its label and cannot answer.

## Data model

Three root maps in the board document (`doc.getMap('polls')`, `doc.getMap('pollAnswers')`, `doc.getMap('pollState')`) and one new step mode.

```
Step (src/types.ts)
  mode: ... | 'poll'        // added to StepMode
  pollId?: Id               // set iff mode is 'poll'; title holds the question

polls: Y.Map<Poll>          // key: poll id
Poll {
  id: Id                    // newId(); equals the key
  question: string          // trimmed, 1–200 characters
  options: PollOption[]     // 2–10 entries
  multiple: boolean         // false: one option per person
  anonymous: boolean        // true by default
  revealed: boolean         // false until the facilitator reveals
  createdAt: number
  createdBy: string         // user id of the creator
  openedAt?: number         // first time the flow moved onto its step
  closedAt?: number         // first time the flow moved off it, or the session ended
}
PollOption { id: Id; text: string }
  // id from newId(); text trimmed, 1–120 characters, distinct (case-insensitive)

pollAnswers: Y.Map<PollAnswer>      // key: `${pollId}:${userId}`
PollAnswer {
  pollId: Id
  userId: string
  optionIds: Id[]           // non-empty, unique, each an option of the poll
  updatedAt: number
  name?: string             // named polls only
  color?: string            // named polls only
}

pollState: Y.Map<boolean | number>  // key: `${pollId}:${field}`, field = revealed | openedAt | closedAt
```

**Changing fields have their own keys.** A poll's definition (question, options, `multiple`, `anonymous`) only changes before it opens. `revealed`, `openedAt` and `closedAt` change later, and often at the same time on different devices: the facilitator reveals while someone moves the session on. As one JSON value the later write replaced the earlier one, so a reveal or a close could be lost. Each now has its own key in `pollState`, so both survive. Reading combines `pollState` with the same fields in the definition: they only move one way, so `revealed` is true if either says so and the earliest time wins. Writes set the `pollState` key and also update the definition, for clients from before `pollState`. A writable client copies these fields from definitions into `pollState` when it loads a board and whenever a definition changes (polls from before this change, or written by an older client), so a later rewrite by an older client cannot take them back.

Rules:

- Values are plain JSON in the `Y.Map`, as `votes` already does. Last writer wins per key. A person writes only their own key, so two people never collide. The same person answering from two devices at once: last write wins.
- A cleared answer deletes its key. Keys are never parsed; the value carries `pollId` and `userId`. Lookups scan the map, as `votesForStep` does. A board has a few hundred answers at most.
- Writes go through `store.transactAs(fn, 'polls')` and are not tracked by the undo manager, as votes are not.
- Option ids are stable. A definition is locked once the poll opens, so answers never point at a changed option.

### Lifecycle

- **Draft**: created, not yet opened. Question, options, `multiple` and `anonymous` can be edited.
- **Open**: `flow.goto` lands on its step, which sets `openedAt`. The definition locks. Answers are accepted while `flow.active` points at this step and `closedAt` is unset.
- **Closed**: the first time the flow moves off the step, the session ends, or the step is removed while open. Sets `closedAt`. Answers are rejected on this client. A poll never reopens: going back to its step shows it closed.
- **Revealed**: `revealed = true`, allowed from open or closed. Stays revealed.
- **Removed**: deletes the poll, its answers and its step if still listed.

The timer shows time left but does not close a poll, as with dot votes.

## Behaviour

- **Answering.** Single choice shows radio buttons, multiple choice shows checkboxes, inside a fieldset with the question as its legend. A choice saves at once; there is no submit button. Single choice replaces the answer, and "Clear my answer" deletes it. Changes are allowed until the poll closes.
- **Responses count.** Before reveal, the card and bar show "N of M answered", where M is the people on the board, as dot voting shows. Choices stay hidden.
- **Results after reveal**, ranked: count descending, ties in option order, zero-count options last. Each row shows text, count and percent of responses. Percentages are of people who answered, so on multiple choice they can total more than 100. With no responses there are no percentages.
- **Names.** Named polls show who chose each option after reveal. Anonymous polls never show names, and anonymous answers store no `name` or `color`.
- **Copy results** puts Markdown on the clipboard:
  ```
  **What should we build next?**
  1. Search (5, 50%)
  2. Export (3, 30%) - Ana, Ben
  10 responses
  ```
  Names appear only for named polls. The results sticky uses the same lines without the bold markers.
- **Results sticky.** "Add results to board" creates one ordinary sticky, at the sticky default size (192×192), in the current sticky colour, with `createdBy` set to the viewer and no `privateStep`. It holds the question and ranked lines as plain text and is placed to the right of the board's content, as imported objects are. It is a snapshot, not live. Ctrl+Z undoes it like any local object.
- **Clear poll** removes the poll, its answers and its step if still listed. Disabled for read-only users.
- **Quick poll** appends a poll step after the active step and moves to it, as quick dot votes do. With no session running, it becomes the session's step, as quick votes do. While a poll is open, the button shows a toast and changes nothing.
- **Finish** removes quick poll steps, as it removes quick dot votes, but keeps the poll. The idle bar then shows the latest closed poll's results until they are cleared.
- **Private notes.** Revealing a poll changes only `poll.revealed`. `flow.reveal` and `privateStep` are untouched, so private notes stay hidden.
- **Dot voting.** A poll step is never a vote step: `handleClick` returns false, `isVoting()` stays false, and no dot badges appear. Dot voting code is not modified.
- **Offline.** Answers are local writes that merge on reconnect. A device that answered before it saw the poll close still counts its answer when it syncs. Closing is a rule between clients, not a server guarantee, because the relay has no clock for it.

## UI

- **Quick poll button** on the left rail, under the dot vote button, with a new `poll` icon. It opens a composer popover: question (autofocused), two option fields by default with add and remove up to 10, "More than one answer" (off), "Anonymous" (on), and **Start poll**. Ctrl/Cmd+Enter starts and Escape cancels. Typing in the composer never triggers tool shortcuts, using the same input isolation as the comment composer.
- **Session bar** (`src/ui/flowbar.ts`). A poll step shows the mode label **Poll** and its question as the step title. Extras: the "N of M answered" chip before reveal, **Reveal results** until revealed, then **Copy results** and **Add results to board**. Idle state: a "Poll results" block for the latest closed poll, with Copy, Add results to board, Reveal (if unrevealed) and Clear poll. The bar's show condition also counts this block.
- **Step editor.** Choosing **Poll** for a step opens the composer for that step, and cancelling reverts the mode. Once a poll has opened, its step cannot change mode and its question is read-only. Removing a poll step removes its poll and answers.
- **Poll card** is docked above the session bar and shown while the active step is a poll. It shows the question, the options (radio or checkbox; disabled for read-only users), "Clear my answer", the response count, and after reveal the ranked list with percent bars and, for named polls, names. On a phone it spans the width minus the 16px gutters, and the options list scrolls inside the card so it never covers Prev/Next/Finish. It uses native inputs in a fieldset, so arrow keys move within radios.
- Styles live in `src/ui/polls.css`, imported from `src/ui/polls.ts`, as `comments.css` is. New strings say "poll", "board" or "results" and never use the product name.

## Roles

Viewers and commenters have a read-only store, as they do for dot votes. Writes are dropped and the controls are disabled.

| Role | Start a poll | Answer | Reveal, copy, sticky, clear | See results |
| --- | --- | --- | --- | --- |
| owner, editor (open mode: everyone) | yes | yes, while open | yes | after reveal |
| commenter | no (board is read-only) | no | no | after reveal |
| viewer | no | no | no | after reveal |
| workspace read-only | no | no | no | after reveal |

The poll methods check `store.readOnly` and report failure, so a refused write shows a toast instead of silently doing nothing. No new role checks are needed.

## Export and import

- **`.drift`**: nothing to add. `polls` and `pollAnswers` live in `doc.yjs`, so the full CRDT state carries them.
- **JSON snapshot** (`toJson`): add optional `polls: Poll[]` and `pollAnswers: PollAnswer[]`, included when non-empty and when no `ids` filter is given, as `comments` is. Step definitions already travel in `flow.steps` with `pollId`. Unrevealed answers are included, because the JSON is a full backup like `.drift`.
- **JSON import into a new board** (`src/main.ts`, the branch without `update`): also restore `polls` and `pollAnswers`. Import into an existing board (`insertImported`) inserts objects only, as today, so no poll steps arrive there.
- **Markdown summary** (`flow.summaryMarkdown()`): appends a `## Polls` section after the frames, with one `###` per opened poll in the order opened. Revealed polls show the ranked list (same formatter as Copy results) and, for named polls, the voters. Unrevealed polls show "Results not revealed". The summary never includes unrevealed tallies or names.
- **PNG and SVG**: polls draw nothing. Only a results sticky, an ordinary object, appears there.

The existing `summaryMarkdown` prints dot totals before reveal. This spec does not change that.

## Tests

New `test/polls.test.ts`, built on the `fakeApp` pattern in `test/flow.test.ts`. `test/flow.test.ts`, `test/store-readonly.test.ts` and the comments tests must stay green without changes.

1. Validation: 2 and 10 options accepted; 1 and 11 rejected; empty question rejected; text trimmed; duplicate option text (any case) rejected.
2. Quick poll with no session: step has mode `poll` and `pollId`, and the session starts on it. With a session running: inserted after the active step. Refused while a poll is open.
3. Single choice: choosing replaces, clearing deletes, unknown option rejected. Key is `${pollId}:${userId}`.
4. Multiple choice: toggling adds and removes; no duplicate ids.
5. Lifecycle: definition edits rejected once open; answers rejected after `goto` moves off, after `end()`, and after the step is removed while open; going back does not reopen.
6. Reveal: sets `revealed`, leaves `flow.reveal` false, and an earlier private-write note stays hidden (`flow.isHidden` true).
7. Read-only store: create, choose, reveal and remove write nothing and report failure.
8. Anonymous: the answer has no `name` or `color`; a named answer has both.
9. Tally: counts, percent of responses, zero rows last, ties in option order, unknown ids ignored, no percentages with zero responses.
10. Markdown: unrevealed shows no counts or names; revealed shows ranked lines; anonymous polls never show names; no `undefined`.
11. Results sticky: one sticky with the expected text, no `privateStep`, removed by undo.
12. Remove: poll, answers and step all gone.
13. Dot voting unaffected: `handleClick` returns false on a poll step.
14. Two docs: answers from two users merge; the same user from two docs leaves one entry; an answer written after close still merges (documents the limit).
15. `.drift` round trip: a doc with polls and answers, encoded and applied to a new `Y.Doc`, keeps its data.
16. JSON: `toJson` includes `polls` and `pollAnswers` when non-empty, omits them with an `ids` filter, and `validate` accepts them.
17. Legacy: a doc without the new maps opens with empty maps and no errors.

UI is checked by hand in the browser, at phone width and desktop, in light and dark: card layout, keyboard (arrows in radios, Escape), viewer and commenter seeing disabled inputs and results only after reveal, Finish then the idle block, and sticky placement. The repo has no UI test harness.

Before reporting an implementation: `npm run lint`, `npm run typecheck` and `npm test`.

## Not in this slice

- Several questions in one poll, free text, rating scales, ranked choice, weighted votes.
- Commenters answering (needs answers in the comments room).
- Cryptographic anonymity or a secret ballot.
- Poll templates, or template steps that use polls.
- A timer that closes a poll, and reopening a closed poll.
- Editing a poll after it opens.
- Keeping the last poll on the board after the flow moves on. Dot votes do this with overlay badges; polls have no overlay.
- A keyboard shortcut.
- An automatic results sticky.
- Notifications, mentions, CSV export, charts on the canvas.
- A schema version bump, and cleanup of orphaned polls.

## Files

### New

- `src/polls.ts`: `Polls` class, held as `Flow.polls`. Validation, create, update, remove, open and close, choose and clear, reveal, tally, Markdown and copy formatter, results sticky. Observes `polls` and `pollAnswers` and calls `app.emit('flow')`. No DOM.
- `src/ui/polls.ts`: quick poll composer popover, poll card, and the results list shared by the card and the bar.
- `src/ui/polls.css`: card, composer and results styles.
- `test/polls.test.ts`: the tests above.

### Existing (touched)

- `src/types.ts`: `'poll'` added to `StepMode`; `Step.pollId?`; `Poll`, `PollOption` and `PollAnswer` interfaces.
- `src/store.ts`: `readonly polls` and `readonly pollAnswers` Y.Maps created in the constructor, not undo-tracked.
- `src/flow.ts`: `readonly polls = new Polls(app)` in the constructor; `goto`, `end` and `setSteps` open and close polls; `quickPoll` delegates to `polls`; `summaryMarkdown` appends `polls.markdown()`. `reveal()` and `handleClick()` are unchanged.
- `src/ui/flowbar.ts`: `MODE_LABEL.poll`; mounts the card above the bar; poll extras; idle "Poll results" block; show condition; step editor's Poll mode.
- `src/ui/board.ts`: quick poll rail button under the dot vote button (about 10 lines).
- `src/ui/dom.ts`: `poll` entry in `ICONS`.
- `src/exporters.ts`: `BoardJson.polls?` and `pollAnswers?`, in `toJson` and `validate`.
- `src/main.ts`: JSON new-board import restores both maps (about 3 lines).
- `README.md`: Polls row after Dot voting; `src/polls.ts` in the layout list.
- `CHANGELOG.md`: Unreleased entry, in the implementation commit.

Not touched: `src/app.ts`, `src/render.ts`, `src/styles.css`, `src/templates.ts`, `src/comments.ts`, `server/`.

## Open questions

1. Lock answers when the poll is revealed? The brief says "until the step ends", so this spec keeps answers changeable after reveal, as dot voting does. Locking on reveal would stop people following the crowd.
2. Anonymity. Recommended: display and export only, since `userId` is in the key, as dot votes already are. Alternatives: hashed keys (still reversible for known participants), or a real secret ballot (needs a server or encryption).
3. Should commenters answer? Recommended: no, matching votes. Yes means answers in the comments room, which changes what that room is for.
4. Anonymous on by default?
5. Should results stay on the board after the flow moves on, as dot results do? Recommended: not in this slice. A results sticky on close is the cheap option.
6. Late answers after close: accept (recommended), or ignore by timestamp.
7. Finish shows only the latest closed poll in the idle bar. Do you want a list of all polls?
8. Markdown summary: exclude unrevealed tallies (recommended). Should the existing dot summary be fixed to match? Separate change.
9. Named polls: include names in the summary after reveal?
10. Limits: 10 options, 200-character questions, 120-character options.
11. No schema bump (recommended). Should older clients refuse files with polls instead?
