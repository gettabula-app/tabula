# Facilitation: planning poker, live Q&A and recurring boards

TAB-145. Status: spec for review. Nothing here is built yet.

Tabula already has the pieces of a facilitated meeting: a session bar with steps and a timer, private writing with a reveal, dot voting, polls, focus requests ("look here") and comments. Three rituals still send people to other tools. A team estimates stories and today uses a poker app next to the board. An all-hands or a workshop collects questions in a chat or a form. A weekly retro starts from a blank template every time, and last week's actions are in someone's notes.

This page specifies the three, and the one mechanism they share with two other specs: **hiding something until a facilitator reveals it**.

- **Planning poker**: a deck, private picks, a reveal, a discussion, a re-vote, and the agreed value written onto a task card.
- **Live Q&A**: questions from the room, optionally anonymous, upvoted, answered by the facilitator.
- **Recurring boards**: "Next session" creates the next instance of a ritual board from its template, copies the open action cards into an "Open from last time" frame and links back.

It is written to fit three neighbours: flip cards (`docs/flip-cards.md`, TAB-128) for reveal, kanban and task cards (`docs/kanban.md`, TAB-134, with owner, due date and status in TAB-163) for what poker estimates and what a recurring board carries over, and TAB-165, the retro-loop issue that was split out of this one and owns the recurring-board work for retros. [Coordination](#coordination-with-the-other-specs) says who owns what.

## Summary

- **Planning poker is a poll with a deck.** A round is a `Poll` of a new kind, `poker`, whose options are the deck's cards, whose answer is one pick per person, and whose target is an object on the board. It runs as a session step (new mode `poker`) with a queue of cards to estimate, so a backlog of twenty stories is one step. Picks are hidden until the facilitator reveals; the reveal shows every pick with a name, the spread and the median, and the lowest and highest pickers speak first. **Vote again** starts a new round and keeps the earlier ones as a short history. **Accept** writes the value on the target card (new field `estimate`) and moves to the next card.
- **Live Q&A is a panel, not a step**, because questions outlive any one step. A **Questions** tray tab (beside Comments) lists open questions by upvotes. People ask (anonymously if the board allows it) and upvote once per question; the facilitator pins one as **Now answering**, marks it answered, hides it or deletes it. A session step of mode `qa` opens the panel and carries the timer for an agenda ("Questions, 20 minutes"); the panel also works with no session.
- **Recurring boards are a series.** A board carries a small `series` record (id, number, previous and next board, cadence). **Next session** (in the board menu, and offered when a session ends) creates the next board from the series' template and copies the open action cards into a frame **Open from last time**, each linked to its original and counting how many times it has been carried over. Creating the board is client-driven, as **Use template** already is.
- **One reveal rule for everything that hides.** Poker, flip cards and Q&A moderation all follow one pattern: the facilitator **writes** a reveal with a time, and every client **reads** it; nobody evaluates a rule that depends on who moved the session. Polls and private notes keep their own fields (nothing is migrated) and the page lists the shared helpers and the one export rule that stops a repeat of TAB-139.
- **Hidden is not secret.** As for polls and flip cards, picks and moderated questions live in the board document. Anyone who can open the board can read them with a tool. The page says so in the interface text, the help and here.
- **Who can take part.** Picks, questions and upvotes are board writes, so in v1 they need edit access (open mode: everyone), exactly as polls and dot votes do today. Letting commenters and viewers take part is the largest open question; [Audience writes](#audience-writes-later) says how.
- **Everything works offline** and travels in `.drift` and JSON files, with one exception: a recurring board links to boards that may not exist elsewhere.
- **No server work in v1**, except an optional follow-up for scheduled creation and a reminder email in accounts mode.

## Decisions and why

1. **Reuse the poll, don't build a second voting system.** A poker round is a question with fixed options and one answer per person, hidden until revealed, closed when the step ends. That is a poll. Reusing `Poll`, `pollAnswers` and `pollState` gives lifecycle, reveal, offline merge, the "N of M answered" chip, export and tests for free. What a poker round adds (a target, a deck, a round number, statistics, accept) is a handful of fields and one module. The alternative, a new `poker` root map, would copy the lifecycle and its bugs.
2. **A poker step has a queue, a round is a poll.** Estimating a backlog is "next card, vote, discuss, vote again, accept, next card". One step per card would make a twenty-step session nobody can edit; one poll for the whole backlog would hide the history. So the step holds the deck and the queue, and each (card, round) is its own poll record. The step's `pollId` points at the current one, as for ordinary polls.
3. **Questions are not polls and not comments.** A comment is a thread pinned to a place and read by people looking at that place. A question is a flat list sorted by votes, read by a room. Questions need a vote count, an answered state and a moderation state that comments do not have. They also outlive a session step. A small new pair of maps (`questions`, `questionVotes`), shaped like `polls` and `pollAnswers`, is the least surprising.
4. **A panel, not a step, for Q&A.** A step belongs to a session and ends when the session moves on; people keep asking questions. The panel is available any time; a step of mode `qa` only gives an agenda item a name, a timer and an open panel.
5. **Anonymity is an interface rule.** A named poll or question keeps `userId` or a name; an anonymous one stores no name and no colour, as polls do. But the board document is readable by everyone who can open it, upvote keys contain the voter's id, and in accounts mode the relay sees which socket wrote what. [Anonymity](#anonymity) states what that means and what the interface promises.
6. **Copy open actions, don't move them.** The next board gets copies with new ids and a link to the original; the old board is left alone. Moving cards would need write access to a board that may be archived, shared with other people or read-only, and would make the previous retro lie about what it decided. Copies also fit the open-mode world, where boards are separate documents.
7. **Client-driven creation.** "Use template" already works by opening a new board id with a `job` (`nav.open(newId(), { template })`, `src/ui/templates-page.ts:20`, applied in `src/main.ts:303-314`). **Next session** is the same call with a bigger job: the template reference and a snapshot of the cards to carry. No new server route is needed for v1, and it works in open mode.
8. **Series links are ids in the document.** A link to the previous board is a board id in the new board's `meta`. It may point at a board the viewer cannot open; the interface says "No access" or "Not found", as it does for any board link.
9. **A shared page for shared mechanics.** Reveal is the same idea in four specs. A thin shared module (`src/reveal.ts`, a few pure functions and one animation rule) is cheaper than four near-copies and is what keeps hidden content out of exports.

## Coordination with the other specs

| Topic | This page | Other spec | Rule |
|---|---|---|---|
| Reveal write and stagger | Poker reveal, Q&A moderation | Flip cards (TAB-128) | Same helpers (`src/reveal.ts`), same 40 ms stagger capped at 400 ms, same reduced-motion rule. Flip cards keep `face` and `faceAt`; poker uses poll reveal. |
| Step fields | `Step.mode` gains `poker` and `qa` | Flip cards add `Step.cards` | Independent. A poker step may also set `cards` (it applies to the step's frame, as for other modes). |
| Task cards | Poker writes `estimate`; recurring boards copy cards | Kanban (TAB-134), task cards (TAB-163) | `estimate` is added here (the kanban spec lists estimates as out of its first slices). Owner, due, labels and lane status are TAB-134 and TAB-163's; this page reads them and never redefines them. |
| Recurring retros | Series model, Next session, carry-over | TAB-165 (retro loop, M2) | This page is the design; TAB-165 builds it for retros first and may ship it before poker and Q&A. See [Recurring boards](#recurring-boards). |
| Custom templates | The series stores a template reference | TAB-82, `docs/custom-templates.md` | A series uses a saved template or a built-in id; the same `job.template` / `job.custom` paths. |
| Picker | Poker: who explains first; Q&A: who answers | Random pickers (TAB-138) | The reveal highlights lowest and highest pickers as a default order. A picker can shuffle the order of people instead; no code shared beyond the highlight. |
| Summaries and exports | Questions, estimates, series in the Markdown summary | TAB-139 (summary hides unrevealed content) | Every new hidden thing goes through `isRevealed` in `src/reveal.ts`, and a test lists the exports. |

## Shared reveal

### What exists

- **Private notes**: `Flow.reveal()` strips `privateStep` from every object and sets `flow.reveal` (`src/flow.ts`). `Flow.isHidden` hides a sticky from everyone but its author until then.
- **Polls**: `revealed` in `pollState`, one-way, per poll (`docs/polls.md`).
- **Dot votes**: totals hidden while `flow.reveal` is false.
- **Flip cards (spec)**: `face` and `faceAt`, newest write wins, personal peeks retire when a newer shared write arrives.

All of them have the same two properties: the reveal is a **write made by whoever pressed the button**, and **every client reads it**. None depends on who moved the session or on a clock the clients share. Keep that as the rule for anything new.

### What is shared

`src/reveal.ts`, pure, no DOM:

- `revealState(map, scope)` and `setReveal(map, scope, shown, now)`: for scopes that can be hidden again (Q&A moderation, poker rounds), a `{ shown, at }` value under a key in a new root map `reveals` (keyed by scope: `poker:<pollId>`, `qa:<questionId>`). Newest `at` wins; ties go to `shown: true` (a reveal is never lost to a simultaneous hide). Polls keep `pollState`; this map is for new things only.
- `isRevealed(scope)`: the single predicate the renderer, the exports, the Markdown summary, the MCP reader and the AI reader call. There is no other way to ask "may this be shown?" for these features.
- `STAGGER_MS = 40`, `STAGGER_MAX_MS = 400` and `staggerDelay(i)`, shared with flip cards, and the reduced-motion rule (no stagger, no turn).
- `revealAnnouncement(...)` strings for the live region.

### The export rule

TAB-139 was a bug where the Markdown summary listed private notes and vote totals before their reveal, because the summary had its own idea of what was visible. The rule for everything in this page: **a hidden thing is hidden in every output**: the canvas, SVG and PNG export, JSON and `.drift` (as far as the format allows; see below), the Markdown summary, the MCP reader, the AI reader, the history preview, comments that quote it. One test file (`test/reveal-leaks.test.ts`) builds a board with every kind of hidden content and asserts that none of those outputs contains it before the reveal and all of them after.

Honest limit: the JSON snapshot and the `.drift` file contain the whole document, and so does the live Yjs state. Hiding is about what the interface and the readers show, not about what the data holds. See [Hidden is not secret](#hidden-is-not-secret).

## Planning poker

### The deck

Decks are lists of cards with a stable id and a label. Built in:

| Deck | Cards |
|---|---|
| Fibonacci | 0, 1, 2, 3, 5, 8, 13, 21, 34, ?, ☕ |
| T-shirt | XS, S, M, L, XL, ?, ☕ |
| Powers of two | 1, 2, 4, 8, 16, 32, 64, ?, ☕ |
| Days | ½, 1, 2, 3, 5, 10, ?, ☕ |
| Custom | 2 to 12 labels the facilitator types (1 to 8 characters each) |

`?` means "I cannot estimate this yet" and `☕` means "I need a break". Both are real picks, shown in the reveal and counted as answers, but left out of the statistics. A card has `numeric` (a number, for statistics and the "nearest card" rule) or it does not; T-shirt sizes and custom labels order by their position in the deck and use the **median card** instead of a mean.

A deck is stored on the step, so it is not looked up later and editing a built-in deck in a later release does not change a past round.

### The step

`StepMode` gains `'poker'`. A poker step carries:

```
Step {
  mode: 'poker'
  pollId?: Id              // the current round's poll; set when the step opens
  poker: {
    deck: { id: string; cards: { id: Id; label: string; value?: number }[] }
    queue: Id[]            // target ids, in order
    index: number          // position in the queue; the facilitator writes it
    accepted?: Record<Id, string>   // target id -> label, so Next can skip what is done
  }
}
```

The queue is chosen when the step is made:

- from the **selection** (stickies, task cards, shapes), in reading order;
- from a **frame or lane**: its cards, in order (a kanban lane is the usual choice: estimate the Backlog lane);
- by **adding cards later** while the step runs (**Add to queue** in the quick-action bar).

A step with an empty queue says so and offers **Select cards**. Removing a card from the board skips it. The queue is whole-array state written only by the facilitator (as `setSteps` is today), so it needs no merge rule.

### One round

A round is a `Poll`:

```
Poll {
  kind?: 'poker'            // absent for ordinary polls
  targetId?: Id             // the card being estimated
  round?: number            // 1, 2, 3 ... for the same target
  question: string          // the target's title, copied when the round starts (may change; the target is the truth)
  options: PollOption[]     // the deck's cards, same ids as the step's deck
  multiple: false
  anonymous: false          // picks are named; see below
}
```

and the answers are the existing `pollAnswers` (one option per person). Its definition locks when it opens, as for any poll.

- **Opening**: when the flow lands on the step, or **Next card** moves the queue, the facilitator's client creates the poll for (`queue[index]`, round 1) and writes `step.pollId`. If two people press at once the later write wins and the earlier poll stays an unused definition (it is removed when it is a draft with no answers; see Limits).
- **Picking**: a deck of large cards under the target. Tap or press a number key to pick; pick again to change until the reveal. The pick is shown to the picker as a raised card; to others, "Ana has picked" (a face-down card with her avatar). Nothing about the value is shown before the reveal.
- **Who has picked** is shown (avatars on face-down cards); what was picked is not. This differs from anonymous polls on purpose: in poker the point is to wait for the slow people, and to ask the fast ones to be quiet.
- **Reveal**: the facilitator's **Reveal** writes `revealed` (the poll's own flag) and the cards turn over with the shared stagger. The row is sorted by value, each card showing its name; the **lowest and highest** are marked ("Start here") and the statistics appear: median, mean (numeric decks), mode, spread, and a one-line verdict (**Agreed** when everyone picked the same card, **Close** when all picks are within one card of each other, **Wide** otherwise). A late pick after the reveal is refused; the poll is closed to answers once revealed (a poker-specific rule, unlike polls).
- **Discuss**: the existing step timer (a per-step duration, default 2 minutes for the discussion phase). The facilitator may start it at the reveal.
- **Vote again** (only after a reveal): closes the round, creates the poll for round + 1 on the same target with the same deck, and clears nothing. Rounds stay in the document and are shown as a strip, `Round 1: 3 5 5 13 · Round 2: 5 5 5 8 · Round 3: 5 5 5 5`, above the cards, so the discussion can see how it converged. At most 5 rounds per target; the sixth asks the facilitator to accept or skip.
- **Accept** (facilitator): chooses the final value and writes it. The default is the consensus card; with no consensus, the median rounded up to the next card; the facilitator can click any card in the deck instead. It writes `estimate` on the target (below) and `step.poker.accepted[targetId]`, in one transaction (one undo step), then moves to the next card in the queue. **Skip** moves on without writing.
- **Back**: the facilitator can step back in the queue to reopen a card; its rounds are shown and **Vote again** starts a new round.
- **Results**: when the queue ends, the bar shows a table of target, estimate and rounds, with **Copy as Markdown** and **Add summary to board** (a sticky, as polls do).

### The estimate on the card

A task card (TAB-134) or sticky gets a flat field:

| Field | Type | Meaning |
|---|---|---|
| `estimate` | string, at most 8 characters | The accepted deck label (`5`, `M`, `½`). Not a number: a T-shirt size is not one. |
| `estimateDeck` | string (optional) | The deck id (`fibonacci`), to show the unit and to restore the right deck next time. |

It shows as a small chip on the card (kanban cards) or in the corner of a sticky, and in the card dialog as **Estimate**, editable by hand (clearing it is allowed). Setting it by hand is an ordinary field edit; poker's **Accept** is the same write with the extra `accepted` record. The kanban spec lists estimates as out of its first slices; this is where they come from, and it needs no kanban code (a card is a box with fields). `estimate` joins the template whitelists, MCP `UPDATABLE`, the Markdown summary (`(5)` after the title) and the CSV export of cards (a column). For a sticky it is allowed on any `sticky`, `shape` and `card`.

**Sums.** A lane header shows the total of its numeric estimates ("Backlog, 7 cards, 34") when any card has one. T-shirt and custom labels are not added.

### Who can do what

| Action | Who |
|---|---|
| Make the step, choose the deck and the queue, reveal, vote again, accept, skip, back | Owner and editor (open mode: whoever starts it; there is no separate facilitator role) |
| Pick | Anyone who can write the board (v1) |
| See the picks after the reveal | Everyone who can open the board |
| Watch (see who has picked, see the reveal) | Everyone, including viewers and commenters |

There is **no facilitator role**. Anyone who can write the board can reveal, as for polls today; a team that wants a single facilitator agrees it. The spec lists this as a question because planning poker is where it bites: someone reveals early.

### Interface

- **Session bar**: poker steps show the target title, "N of M picked", **Reveal**, **Vote again**, **Accept** (a split button with the proposed value), **Skip**, **Back**, and the queue position ("3 of 12"). The bar is one line today and already tight on a phone, so on small screens the controls live in the poker card instead.
- **Poker card**, docked above the bar like the poll card: the target (title, description for a task card), the deck, the face-down row, the round strip and, after the reveal, the statistics and the sorted cards. It uses real `<button>`s in a labelled radiogroup, number keys, arrow keys, and a live region ("7 of 9 have picked", "Revealed. Low 3 from Ana, high 13 from Ben. Median 5").
- **Phone**: the deck is a grid of large cards in a bottom sheet (3 across), one tap to pick; the picked card stays raised; the sheet shows the target above and the picked state below ("You picked 5. Tap another to change."). After the reveal the sorted list is a vertical list with names. The facilitator's controls are a pinned row at the bottom.
- **Following the target**: the board flies to the target when a card becomes current (the step's frame fly, as other steps), but only for the person who moved the step, as today (`Flow.onFlowChange` flies on `local` changes). Others are not moved; a **Go to card** button in the poker card centres the target.
- **Keyboard**: with the poker card focused, digits and `?` and `C` pick the matching card (`0` to `9`, `?` and `c` for ☕); `Enter` reveals for the facilitator.
- Styles in `src/ui/poker.css`, imported from `src/ui/poker.ts`; colours come from tokens (the five themes); the cards use the sticky-colour palette only for the picked state, not for meaning.

### Export and other outputs

- **Markdown summary**: a "Planning poker" section listing target, estimate and the rounds' picks (names) only for revealed rounds.
- **Copy results** and **Add summary to board** as above.
- **SVG/PNG export**: the target cards show their `estimate` chip. Unrevealed picks are not drawn (they are not objects).
- **MCP**: `get_board` returns the estimate on cards and a `poker` summary for revealed rounds only; `update_objects` may set `estimate` (validated against 8 characters). No tool reads unrevealed picks or writes picks.
- **AI**: "Suggest estimates" is a natural later feature (a proposal of `estimate` values, shown as a preview as TAB-97 proposals are); it is not in this spec and the tools never see picks before the reveal.

## Live Q&A

### What it is

A list of questions for a room. Anyone can ask; everyone can upvote once per question; the facilitator decides what is shown, in what state, and what is being answered now. It works in a meeting of eight and in an all-hands of eighty.

### Data

Two new root maps in the board document, shaped like the poll maps:

```
questions: Y.Map<Question>           // key: question id
Question {
  id: Id
  text: string                       // trimmed, 1 to 280 characters, plain text
  at: number                         // created
  by?: string                        // user id; ABSENT for an anonymous question
  name?: string                      // display name at the time; absent when anonymous
  color?: string                     // cursor colour; absent when anonymous
}

questionVotes: Y.Map<number>         // key: `${questionId}:${userId}`, value: when
```

The facilitator's decisions are **not** fields of the question. They change later and by other people than the author, so, following the rule `pollState` set for polls (changing fields get their own keys), they live in the `reveals` map of [Shared reveal](#shared-reveal): `qa:<id>` holds `{ shown, at }` (moderation: hidden or approved) and `qa-answered:<id>` holds `{ shown: true, at }` when the question was marked answered (and `shown: false` when it was reopened). A facilitator marking a question answered therefore never races with its author correcting a typo, and two facilitators acting at once merge by the newest-wins rule. The reader combines them into the `open`, `answered` and hidden states used below.

A **current question** is one value in the `flow` map, `qaCurrent: Id | null`, written with origin `'flow'` (not undoable), as `focus` is. It drives the **Now answering** banner.

Rules:

- The author writes their own question; the facilitator writes `reveals`. Votes are one key per person, deleted to withdraw. Nobody writes another person's vote.
- Counting scans the maps, as `votesForStep` does. Limits keep it small ([Limits](#limits)).
- Writes go through `store.transactAs(fn, 'qa')`: not undoable by the undo manager, like votes and polls.

### Asking

- **Questions** tray tab (next to **Comments**), opened by a button in the top bar with an unread-style count of open questions. **Ask a question** is a composer at the top (a labelled textarea, a character counter, an **Ask anonymously** switch when the board allows it, **Send**; Ctrl/Cmd+Enter sends, Escape clears). Typing never triggers a board shortcut (the same isolation as the comment composer).
- **Rate**: one question per 10 seconds per person and at most 3 unanswered questions per person at a time, enforced on the client (the doc is open to any editor's tool, so this is politeness, not security). Someone over the limit sees why.
- **Editing and withdrawing**: an author can edit or delete their own question while it is open and has no votes besides their own. After that it can only be withdrawn (hidden by the facilitator on request). An anonymous question has no `by`, so the author is recognised on **this device** by a list in `localStorage` (`tabula:qa:mine:<board>`, question ids, capped at 200), wrapped in try/catch as other local state is. On another device the author cannot edit it. That is stated in the composer ("You can withdraw this only on this device").
- **Duplicates**: while typing, near matches (case-insensitive word overlap against open questions) are offered as "Already asked. Upvote instead?" Merging two questions is not in v1.

### Voting and ordering

- One upvote per person per question, toggled; you may upvote your own. The count is visible at once (unlike poker picks: popularity is the point, and hiding it would defeat the list).
- Order: open questions by votes descending, then by time ascending (older first); **Answered** collapsed below, newest first; **Hidden** (facilitators only) at the end.
- Reordering is smooth but never moves a row under the pointer while it is being pressed (the list keeps the order until pointer-up, then settles), a common live-Q&A annoyance.

### Facilitating

- **Now answering**: **Pin** puts one question in a banner at the top of every person's board ("Now answering: …", with its votes), written to `flow.qaCurrent`. One at a time; unpinning clears it. The banner does not move anyone's view (focus requests do that, TAB-111).
- **Mark answered**: moves it to Answered and clears the banner if it was current; **Reopen** reverses it.
- **Hide** (facilitators): sets the moderation state to hidden. The question disappears for everyone except facilitators, who see it dimmed with **Restore**. **Delete** removes it and its votes.
- **Moderated mode** (a switch in the Questions header, off by default): the asker's client writes the question and, in the same transaction, `qa:<id>` with `shown: false`, so it is hidden from the first moment; a facilitator **Approves** each with a newer `shown: true`, the same write as **Restore**. The author sees their own question as "Waiting for the facilitator". The switch is stored in `flow.qaModerated` (a session setting, not undoable).
- **Anonymous allowed** (another switch, `flow.qaAnonymous`, on by default): when off, the composer has no anonymous option and every question carries the author's name.
- **Who is a facilitator**: anyone who can write the board and has the Questions tray open as a facilitator: there is no separate role, as for polls. The moderation controls show for every editor.
- **Presenter view**: the **Present** button in the tray opens the list in a large-type overlay for a projected screen, showing the current question or the top three open ones, with no controls. It is local to that device.
- **Q&A step**: a step of mode `qa` opens the tray on every device when the session moves there (the step's client-side behaviour, as the poll card appears for a poll step) and has the usual timer. Moving on closes nothing: questions stay.
- **Closing Q&A**: the facilitator can **Close questions** (`flow.qaOpen: false`): the composer is disabled with "Questions are closed"; existing questions stay and can be upvoted and answered. Re-open at any time. It is on by default (so ad-hoc use needs no setup).

### Anonymity

What the interface promises, and what it does not:

- An anonymous question shows no name, no colour and no avatar to anyone, including facilitators, in the panel, the presenter view, the Markdown summary, the CSV and the MCP and AI readers. The question record has no `by`.
- **Upvotes are not anonymous in the data.** The vote key contains the voter's id, as dot votes and poll answers do. The interface never lists who upvoted.
- **The relay can attribute writes** in accounts mode (it knows which connection sent an update) and in any mode a person with a tool can read which client wrote a Yjs update. Anonymous means "not shown", not "cannot be found out".
- The composer says "Anonymous here means other people do not see your name. It is not a secret from the workspace administrators." in accounts mode, and "…not a secret from people who can read the board's data" in open mode.
- Exports and the history of the board keep the record without `by`, so a restored version cannot unmask an author either.

### Hidden is not secret

Hidden questions, unrevealed picks and moderated items are in the board document. The interface and the readers in [The export rule](#the-export-rule) hide them. Nothing here is a confidentiality feature, and the help text on each says so in one line.

### Phone

The tray is a full-height sheet; the list scrolls; **Ask** is a sticky bar at the bottom that opens the composer above the keyboard. Each row has the question, the vote button (a 44 px target with the count), and a **⋯** menu for facilitators. The Now answering banner is one line, truncating with an ellipsis, tap to open the full text.

### Outputs

- **Markdown summary**: a "Questions" section, answered first (with `(votes)`), then open ones; hidden and pending questions only for facilitators generating it, using the same rule as the board (`isRevealed`); anonymous ones have no author.
- **CSV** (`Export > Questions as CSV`, same writer and formula guard as the kanban card export): `question, votes, state, asked_at, answered_at, author`; `author` empty for anonymous.
- **SVG/PNG**: not drawn. A **Add to board** action on a question creates an ordinary sticky with its text (a way to turn a question into a discussion card) and does not carry the author.
- **MCP**: `list_questions` (read token): text (fenced), votes, state; never `by` for anonymous; hidden ones only where the token's person would see them. No write tools in v1.
- **AI**: **Summarise** may read questions (fenced, no names) so "what is the room asking?" works; "merge duplicates" is a later feature.

## Recurring boards

TAB-165 splits this off for the retro loop and owns building it for retros. The model below is shared so that rituals other than retros (weekly planning, a standing sync, a class) get the same thing.

### The series

A board belongs to at most one **series**: a chain of instances of one ritual. The series record lives in the board's `meta`:

```
BoardMeta {
  seriesId?: Id               // shared by every instance
  seriesN?: number            // 1 for the first
  seriesPrev?: Id             // previous board id
  seriesNext?: Id             // next board id, written when the next one is created
  seriesName?: string         // "Sprint retro"
  seriesTemplate?: string     // a built-in template id, or "custom:<id>" (TAB-82)
  seriesCadence?: 0 | 7 | 14  // days; 0 means "no schedule"
}
```

All flat keys, whole values, written by the creator of an instance. `setMeta` already merges per key. In accounts mode the same ids are also kept in the directory so the home screen can group a series without opening every board (slice 2: columns `series_id`, `series_n`, `series_prev` on `boards`, migration 7 or the next free number).

**Making a board recurring**: **Board menu > Make recurring…** opens a small dialog: **Repeats** (Every week, Every 2 weeks, No schedule), **Name** (default the board title), **Template for the next one** (the template this board came from if it has one recorded, **Use this board's structure**, or **Choose a template…**). It writes the series keys with `seriesN: 1` (or keeps the number if it is already part of a series). No cadence is also fine: a ritual without a clock still wants "Next session".

**Board structure as a template**: for a board not made from a template, **Use this board's structure** builds the next board from the current one with its content removed: frames, lanes, prompts (text objects that live in frames and are not stickies), session steps and fonts stay; stickies, cards and drawings do not. This is `toTemplateContent` (`src/custom-templates.ts:92`) with a filter, the same code **Save board as template** uses. It is stored on the series record as a saved custom template (accounts mode, on the server) or inline (open mode, in the board's `meta` as one value of at most 200 KB) so the next board does not depend on the previous one's current state.

### Next session

**Board menu > Next session**, and **Start next session** offered in the session bar when the session ends and the board is part of a series (or when a series has a cadence and today is on or past the due date).

1. Choose what to carry: a dialog lists the open actions found (title, owner, due, how many times carried), all ticked, with **Carry over** and **Skip**. It says "No open actions" when there are none.
2. The client creates a new board id and opens it with a job `next: { from: <board id>, series: …, carry: [cards] }`, the way **Use template** opens one (`nav.open(newId(), { template })`, `src/ui/templates-page.ts:20`).
3. When the new board opens (`src/main.ts`, where `job.custom` and `job.template` are applied today), it, in order and in one transaction where possible: sets the board name (`<series name>, <date>` or `…, session N`), writes the series keys (`seriesN + 1`, `seriesPrev = from`), instantiates the template, and creates the **Open from last time** frame holding copies of the carried cards.
4. The client then writes `seriesNext` on the **previous** board if it can (an editor there). If it cannot (read-only, no access), the link is one way and the previous board's header says nothing; the new board still links back. A failed write is not an error.

In accounts mode the new board belongs to the same team and has the same sharing as the previous one: the creating call passes `teamId`, and the owner of the previous board is the owner of the next if the creator is its owner, else the creator owns it and the team gets it. Shares of individual people are **not** copied (a retro with an invited guest does not silently invite them again); the dialog says so and offers **Copy sharing** for owners.

### What counts as an open action

This depends on TAB-134 and TAB-163 and is defined here only as far as needed.

- A **task card** is open when its status is not `done`. TAB-163 owns the status field; for a card in a kanban lane the status is the lane's `stage` (TAB-134); for a loose card it is its own status field.
- A **sticky** in a frame the template marked as an actions frame is also an action: the frame gets a flat field `role: 'actions'` (set by the retro templates, editable in the frame's properties). Stickies carry no status, so a sticky is "open" unless it has `done: true`, a new flat boolean toggled by **Mark done** in the quick-action bar (drawn struck through). Offering **Turn into card** (TAB-134) for them first is the better path, and the **Carry over** dialog says "3 stickies in Actions: turn them into cards" with a button.
- Anything else is not carried. In particular, discussion stickies and votes are not.

### The copy

For each carried item the new board gets a **new object** (new id, `createdBy` the creator, `createdAt` now) with:

- the same text, description, owner, due date, labels, estimate and colour;
- `carried: n + 1` (a number; the copy of a first-time action has `carried: 1`), shown as a small badge "carried 3×" when it reaches 2, and in the warning colour from 3;
- a link back, `origBoard` and `origId` (flat strings): the board and the object it was copied from. **Open original** in the card dialog navigates there (and says "No access" or "Not found" instead of failing silently);
- no comments, no votes, no private-step markers, no connectors.

Placement: in a frame **Open from last time** at the left of the new board's template content, cards stacked top to bottom ordered by due date (soonest first, undated last), with the frame's height following the count. If the template already has an actions area, the carried cards go in a lane or frame named **Open from last time** beside it, not into it, so new actions and old ones stay distinguishable.

**Done in the new board** does not change the old one. The old board's copy of the action stays open forever in its own history, which is correct: it is what was decided then. A later version can ask "Mark done on the previous board too?" when the person can edit it; it is not in v1.

**Copies of copies**: carrying a card again copies the latest copy and increments `carried`; `origBoard`/`origId` always point to the **first** original, and `prevBoard`/`prevId` (also flat) to the immediate previous copy, so a chain can be followed in either direction.

### Series navigation

A board in a series shows **Session N of <name>** in the board menu, with **Previous** and **Next** links (to boards that exist and are visible; a missing one shows as disabled with the reason). The home screen groups a series under its name in accounts mode (slice 2) and, in open mode, lists boards as it does today with the series name as a subtitle.

### Scheduling and reminders (later)

TAB-165 asks for "every 1 or 2 weeks". v1 stores the cadence and shows **Next session due Oct 21** with a **Create next** button on the latest board of a series in the home list, and does nothing on its own. A scheduled creation (the server creates the next board at the right time, adds the carried cards and emails the team "Your retro board for Oct 21 is ready") needs a server job and the mailer, and the carried cards are a client-computed snapshot today. The slice list has it as a follow-up with a server-side carry-over function in `server/board-ops.mjs` (the same reader MCP uses), which is also what would let MCP and agents create a next session (**TAB-167** wants the agent team's retro on a board).

### Outputs and limits

- **Markdown summary**: the series name and number, "Previous: …" and a "Carried over" section for the frame.
- **Export**: series keys travel in the board's meta in JSON and `.drift`; importing keeps them, and a link to a board that does not exist is shown as unavailable.
- **MCP**: `get_board` returns the series keys and the `carried`, `origBoard` fields; `update_objects` can set `done` on a sticky and the task-card fields TAB-163 defines; no tool creates the next session in v1.
- At most **50 cards** carried per session (the dialog says so); a series has no limit on length; the template stored inline is at most 200 KB and 2,000 objects.

## Permissions

| Feature | Who |
|---|---|
| Poker: make, reveal, vote again, accept, skip | Owner, editor (open mode: everyone) |
| Poker: pick | Anyone who can write the board (v1) |
| Q&A: ask, upvote | Anyone who can write the board (v1) |
| Q&A: pin, answer, hide, delete, moderate, close | Owner, editor |
| Make recurring, Next session | Owner, editor of the board, and permission to create a board in the target team |
| Watch (see revealed picks, questions, banners) | Everyone who can open the board |

The relay checks only the room role (`canWriteRoom`, `server/relay.mjs:85-90`), and board rooms have no per-object validation: any editor can in principle write another person's pick or vote by hand with a tool, exactly as dot votes allow today. The keys carry the user id, the client writes only its own, and nothing here upgrades that to a server guarantee. The interface text for poker and Q&A does not claim one.

### Audience writes (later)

Q&A and poker are most useful with **people who cannot edit the board**: an all-hands where staff are viewers, a class where students are commenters. Viewers cannot write the board room at all (their updates are dropped, `relay.mjs:325-336`), and commenters write only the comments room (`~comments`).

The route that fits the architecture is a third root map in the **comments room**, `audience`, that holds per-person writes (questions, upvotes, poker picks) with a guard like `createCommentGuard` (`server/comment-authz.mjs`) that, in accounts mode, rejects any key whose user part is not the authenticated person. Commenters could then take part; viewers still could not, so a **participant** role between viewer and commenter ("can answer polls and questions, cannot change the board or comment") would be the product answer. This is a separate decision with a server component and it affects polls too, so it is **not** in this spec's slices, but the data layout is chosen so that moving the three maps (`questions`, `questionVotes`, and the poker picks in `pollAnswers`) is mechanical: every audience write is a single key owned by one person, and nothing needs to read the board objects in the same transaction.

## Templates

- **Planning poker (backlog)**: a kanban container (TAB-134; until it exists, a frame of stickies) with a Backlog lane, an Estimated lane, three sample cards, and a poker step over the Backlog lane with the Fibonacci deck and a 2-minute discussion timer.
- **All-hands Q&A**: a title frame with an agenda, an open Questions tray step of 20 minutes, and a closing step.
- **The retro templates** (Start / Stop / Continue, 4Ls, Mad / Sad / Glad, Sailboat, Pre-mortem) gain `role: 'actions'` on their **Actions** frame so **Next session** finds actions with no setup. An update to `retroLayout` in `src/templates.ts:90`, and nothing else in them changes.
- Both template whitelists and the validator (`src/custom-templates.ts`, `server/templates.mjs`) accept the new step modes (`poker`, `qa`), the step's `poker` object (deck and queue validated: card count, label length, queue ids exist in the template), `role` on frames (`'actions'`) and the card and sticky fields `estimate`, `estimateDeck`, `done`, `carried`, `origBoard`, `origId`, `prevBoard`, `prevId` (the last four stripped when saving a template, since they name boards). A template never carries picks, questions, votes or series keys.

## History, undo and offline

- **Undo**: poker accept (estimate and accepted record) is one undo step; making a step, reveal and picks are not undoable (session control and answers are not, as for polls). Questions, votes and moderation are not undoable. A carried copy and the creation of the next board are one undo step on the new board.
- **History**: version snapshots include the new maps and fields. **Restore** (`planRestore`, `src/history.ts:114`) treats `estimate`, `done` and the carry fields as ordinary object fields. The three new root maps are not restored by object restore, as polls are not: a restored version does not resurrect answered questions.
- **Offline**: picks, questions and votes are local writes that merge on reconnect. A pick made after the facilitator revealed (offline at the time) is refused when its device syncs (the round is closed), but it may still sit in the document; readers ignore picks written after the reveal time for display and statistics, using the answer's `updatedAt`. Creating the next board offline works: the new board is a local document that syncs when the relay returns; `seriesNext` on the previous board is written when it can be.

## Limits

| Thing | Limit |
|---|---|
| Cards in a poker queue | 100 |
| Rounds per card | 5 |
| Custom deck | 2 to 12 cards, 1 to 8 characters each |
| Questions per board | 500 (new ones refused with a message; the facilitator can delete or hide) |
| Question text | 280 characters |
| Open questions per person | 3, and one per 10 seconds |
| Upvotes | one per question per person |
| Carried cards per session | 50 |
| Series name | 80 characters |
| Stored structure template (open mode) | 200 KB, 2,000 objects |

Over a limit the client says so and does nothing. The relay does not enforce them (it does not look inside board updates); the MCP tools do.

## Tests

Unit (no DOM):

- `reveal`: newest write wins, ties to shown, `isRevealed` for every scope kind, the stagger values, the export rule across every output (`test/reveal-leaks.test.ts`: canvas markup, SVG, JSON, Markdown summary, MCP reader, AI reader, history preview).
- `poker`: deck definitions and numeric flags; statistics (median, mean, mode, spread, verdict) over agreed, close and wide sets, with `?` and ☕ excluded; the default accept value (consensus, nearest card, a T-shirt median); round creation and re-vote (round numbers, locked definitions, 5-round cap); two facilitators pressing at once; a late pick after reveal ignored; queue edits (add, remove, back, skip); `accepted`; undo of accept is one step.
- `qa`: ordering (votes, then time), one upvote per person and toggle, rate limits, near-duplicate suggestion, moderated mode (pending hidden for others, visible to the author as waiting), hide and restore, pin and unpin and mark answered clearing the banner, anonymous questions with no `by`, the local "mine" list, the 500 cap, text trimming and length, plain text only.
- Two real `Y.Doc`s synced: concurrent upvotes, an author edit against a facilitator hide, two facilitators pinning different questions (last one wins, one banner), poker picks from several clients, accept against vote-again.
- `series`: keys written on make-recurring, `Next session` building the job, carry-over rules (task card open by lane stage, loose card status, sticky `done`, actions frame, other stickies skipped), the copy (new id, `carried`, `origBoard`, `prevBoard`, no comments or connectors, placement order by due date), copies of copies pointing at the first original, 50-card cap, a failed write of `seriesNext` tolerated.
- Templates: new step modes and fields accepted by both validators and refused when malformed (queue ids missing, deck too long, `role` other than `actions`), the stripping of board-naming fields on save, the retro templates' actions frames.
- Summary and CSV: the questions section and CSV (formula guard, anonymous author empty, hidden excluded), the poker section only for revealed rounds, series line.
- MCP: `list_questions` fencing and withholding, `get_board` estimate and series fields, `update_objects` for `estimate` and `done`.
- UI logic (pure files): deck key handling, the picked/waiting view model, the live region text, the Q&A list model with the "do not reorder under the pointer" rule, the carry dialog model.

Browser checklist (not CI): two windows picking, reveal and the ripple, vote again, accept writing the chip on a kanban card; Q&A with three people (ask, upvote, pin, answer, anonymous, moderated); Next session on a retro in open and accounts mode; the phone sheets at 390 px; the five themes; reduced motion.

## Not in this slice

- A facilitator role separate from editor, and an audience or participant role (see Audience writes).
- Scheduled creation of the next board, reminder emails, calendar integration.
- Moving carried cards (copy only) and writing "done" back to the previous board.
- Linking a series to Linear or Jira (TAB-134's later work covers cards; a series is not part of it).
- Merging duplicate questions, threads or replies on questions, question categories, per-question timers.
- Poker decks with images, a "confidence" pick, weighted estimates, velocity and burn-down charts, and exporting estimates to a tracker.
- An AI that suggests estimates or merges questions (a clearly marked follow-up; it must not see unrevealed picks).
- Anonymous picks in poker.
- Server-side limits and server-side per-person write guards for the new maps.
- Retro-specific analysis (themes across weeks, who carries what) beyond the `carried` count.

## Slices

1. **Shared reveal and the model.** `src/reveal.ts` and its tests, the `reveals` map, the leak test, `Step.mode` additions, the `poker`, `question` and series types, template whitelist and validator additions, `estimate`, `done` and carry fields in the object field lists, the retro templates' `role: 'actions'`. No UI.
2. **Planning poker.** Deck module, round creation and re-vote, statistics, accept and the estimate chip, the poker step in the step editor, the poker card and bar controls, phone sheet, keyboard, live region, Markdown summary section, the Planning poker template, MCP estimate fields. Coordinates with TAB-134 (the card chip) and TAB-128 (stagger).
3. **Live Q&A.** The two maps, the tray tab and composer, voting and ordering, moderation, Now answering, the `qa` step mode, Present, summary and CSV, `list_questions`, the All-hands Q&A template.
4. **Recurring boards, client side (TAB-165's slice for retros, shared here).** The series keys and **Make recurring** dialog, structure-as-template, **Next session** and the carry dialog, the **Open from last time** frame and copies, series navigation, summary lines. Depends on TAB-134 and TAB-163 for task cards; with stickies and `done` it works earlier.
5. **Accounts mode and home.** Directory columns for series, the home grouping, due-date display and **Create next**, **Copy sharing**.
6. **Scheduling and reminders.** Server job, carried snapshot computed on the server, the mail, MCP creation of the next session (for agent retros, TAB-167).
7. **Audience writes** (its own spec): the `audience` map, the guard, the participant role, moving poker picks and Q&A into it.
8. **Docs.** The user guide pages (a Facilitation page covering all three, linked from Sessions), `docs/polls.md` cross-link, CHANGELOG.

Slices 1 and 2 are the smallest useful poker; 3 stands alone and can ship before 2; 4 should ship with, or just after, TAB-163.

## Files

### New

- `src/reveal.ts`, `src/poker.ts`, `src/qa.ts`, `src/series.ts` (pure logic: decks and statistics, question model, series and carry-over)
- `src/ui/poker.ts`, `src/ui/poker.css`, `src/ui/qa.ts`, `src/ui/qa.css`, `src/ui/series.ts` (dialogs, the carry list)
- `server/` nothing in slices 1 to 4; slice 5 touches `directory.mjs` and slice 6 adds a scheduler
- tests listed above

### Existing (touched)

- `src/types.ts` (`StepMode`, `Step.poker`, `Question`, `BoardMeta` series keys, the object fields), `src/store.ts` (the `questions`, `questionVotes` and `reveals` maps and `getFlow` fields `qaCurrent`, `qaModerated`, `qaAnonymous`, `qaOpen`), `src/polls.ts` (`kind`, `targetId`, `round`, the poker closing rule), `src/flow.ts` (poker and qa steps, queue moves, `onFlowChange`), `src/ui/flowbar.ts` (bar controls, step editor), `src/ui/board.ts` (menu items, tray tab), `src/ui/props.ts` and `src/ui/quickbar.ts` (estimate, **Mark done**, **Add to queue**), `src/markup.ts` (the estimate chip, struck-through done sticky, carried badge), `src/templates.ts`, `src/custom-templates.ts`, `src/main.ts` (the `next` job), `src/ui/templates-page.ts` (job type), `src/history.ts`, `src/exporters.ts` (JSON/`.drift` fields), `src/shortcuts.ts` (poker keys while focused)
- `server/board-ops.mjs` (summaries, `UPDATABLE`, `list_questions` reader), `server/mcp.mjs` (tool), `server/templates.mjs` (validator), `server/directory.mjs` (slice 5)
- `docs/polls.md`, `docs/flip-cards.md` (a cross-reference to the shared helpers), `docs/kanban.md` (the estimate field), `docs/custom-templates.md`, `docs/mcp.md`, `docs/guide/` (a Facilitation page when it ships), `CHANGELOG.md`

## Open questions for Johan

1. **Who takes part?** v1 needs edit access to pick or ask, as polls do. For all-hands and classes that excludes the audience. Do you want the participant-role route (a new role, a guard in the comments room; its own spec) before Q&A ships, or after, or never?
2. **Facilitator role.** Anyone who can edit can reveal, vote again and accept. Planning poker is where an early reveal hurts. Is "whoever started the step" enough (store `startedBy` and ask for confirmation otherwise), or a real role?
3. **Poker picks named from the start, hidden until reveal** (drafted), or anonymous polls' model? Poker needs names for the discussion; this spec treats that as settled.
4. **Estimate lives on the card** as a string with an optional deck id (drafted). Should it also drive lane sums for numeric decks (drafted yes) and be exported to the tracker later?
5. **Re-vote history**: five rounds, shown as a strip (drafted). Is that the right number, and should the history be kept on the card afterwards (an `estimateRounds` string) or only in the poll records?
6. **Anonymity wording.** The spec states that anonymous is not secret from administrators or from anyone who reads the data, and puts that in the composer. Acceptable for an all-hands, or does anonymity need a server component (the relay stamping and then dropping authorship), which is a large change?
7. **Q&A moderation default** is off and **anonymous allowed** is on (drafted). Which defaults for a workspace? Should an admin setting decide?
8. **Question limits.** 280 characters, 3 open per person, one per 10 seconds, 500 per board (drafted). Right for an all-hands of 200?
9. **Q&A in the comments room** (it would let commenters ask) versus the board room (drafted, editors only). This is the same decision as question 1 for this feature.
10. **Series and carry rules.** Open means status not done for cards and `done` not set for stickies in an actions frame (drafted). Is "stickies in an Actions frame count" right, or should only task cards be carried (cleaner, and it makes TAB-163 a hard dependency)?
11. **Carry copies, never moves** (drafted), with an optional write-back of "done" to the previous board later. Is the one-way link enough?
12. **Copy sharing.** The next board gets the same team but not individual shares (drafted). Right?
13. **Scheduling.** Is a manual **Next session** plus a due-date reminder on the home list enough for v1, with automatic creation and email left for slice 6?
14. **Order of work.** TAB-165 is High priority and in M2 (Retro loop), poker and Q&A are Medium. Drafted: slices 1 and 4 first (the shared model and the retro loop), then poker, then Q&A. Confirm, or put poker first?
15. **Series name and one template per series.** A series has one template. If a team changes its retro format, they make a new series (and **Next session** says so). Is that acceptable, or should **Next session** offer "Use a different template this time"?
