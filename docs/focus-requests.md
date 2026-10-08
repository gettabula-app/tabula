# Focus requests and following

Nobody can move another person's view. A person can ask others to look at theirs, and each person chooses whether to go there, follow, or ignore the request.

## What people see

- **Ask everyone to look here** (the crosshair icon on the session bar). It sends a request and moves nobody. It is open to everyone on the board, including people with view-only access, because it changes nothing in the board. After a request the button waits 10 seconds, and its tooltip counts down.
- **Moving the session to a step** that has a frame flies the person who changed the step to the frame, and no one else. Everyone else gets the same kind of request: "Ana moved to step "Cluster"".
- **The card** appears above the toast, never takes focus and never blocks the board. It offers **Go to** (one flight to the view or the step's frame), **Follow**, **Dismiss** and **Mute Ana**. It goes away after 20 seconds, or less when the request is already old. Nothing moves until a button is pressed. At most three cards show; a newer request from the same person replaces their card.
- **Follow** keeps your view on the other person's view. It ends when you pan, zoom or move the camera in any way, press Esc, press Stop on the chip that shows while you follow, or the other person leaves. While you follow someone, their requests and step changes show no card, because your view already goes where theirs goes.
- **Mute** ignores one person's requests silently on this board. It is stored in this browser under `driftboard:focus-muted:<userId>:<boardId>` as a list of `{id, name}` (the name is kept so the list can show people who are offline). **Muted people (N)** in the board menu, shown only when someone is muted, lists them with an Unmute button.

## Protocol

Requests and views travel on the Yjs awareness state of each client, not in the board document, so they are never saved, never in history and never in exports, and the relay needs no change. Awareness states of clients that leave disappear with them.

| Awareness field | Value | Set by | Cleared |
| --- | --- | --- | --- |
| `focusRequest` | `{ id, x, y, zoom, ts, from: { id, name, color }, kind: 'view' \| 'step', stepId?, stepTitle? }` | The person asking, or the person who moved the session to a step | After 30 seconds |
| `following` | Awareness client id of the person being followed, or `null` | The follower | When following ends |
| `view` | `{ x, y, zoom }`: the centre of the sender's view in board coordinates, and the zoom | A client that another client names in `following` | When nobody follows it |

A client sends `view` only while someone follows it, at most about every 120 ms, so ordinary presence traffic does not grow. A follower applies a view only if it differs by more than half a screen pixel or a thousandth of the zoom.

For a `step` request, `x`, `y` and `zoom` are the centre of the frame and 1. Go to flies to the frame of the step named by `stepId` (looked up when the button is pressed, so it is right even if the frame moved) and falls back to those numbers. A session step without a frame sends no request: it never moved anyone.

### What a recipient ignores

In this order, per request id (each id is judged once):

1. A request from the same person id (another tab of mine).
2. A `ts` more than 5 seconds ahead of the local clock (clocks differ a little), or older than 30 seconds.
3. A person who is muted.
4. A person this tab follows.
5. A repeat from the same person within 10 seconds. For a view request the repeat is any view request; for a step request it is the same step, so moving through steps quickly still shows each one.

A request is also ignored when `from.id` is not the `user.id` that the same client announced on its awareness state, when the shape is wrong, when numbers are not finite or are out of range, or when `step` lacks `stepId` or `stepTitle`. Names are trimmed and cut to 40 characters, titles to 80, and a colour is kept only if it is a hex colour. All text is shown as text.

A sender allows itself one request every 10 seconds. That limit is on the button, so the protocol relies on recipients for protection against a modified client.

### Old versions

The earlier "Bring everyone to my view" wrote `flow.focus` into the board document and every other client flew there. That is gone: this version never writes `flow.focus` and ignores it when it reads a board, so an old tab that still writes it moves nobody on a new version. Old tabs will still fly to a `flow.focus` written by another old tab, and do not show the new cards.

## Code

- `src/focus-requests.ts`: the logic, with no DOM: checking a request, the cooldown, `RequestTracker` (what becomes a card), mute lists and their storage, and the view maths for following. Tested in `test/focus-requests.test.ts`.
- `src/flow.ts`: a step change flies only the screen where it was made (`transaction.local`), and calls `onLocalStep` so the request can be sent. Tested in `test/flow-focus.test.ts`.
- `src/ui/focus.ts` and `src/ui/focus.css`: the cards, following, the chip and the muted list.
- `src/ui/flowbar.ts`: the Ask button and its countdown.
