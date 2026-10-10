# Sessions and focus requests

A session is a facilitated sequence of timed steps that you run on the board, such as writing, grouping, voting and discussing. Everyone on the board sees the same step and the same timer.

## Start a session

You can begin a session in three ways:

- Add a session template from **Templates and team exercises** in the toolbar. Retrospective, brainstorm, prioritisation and planning templates come with frames and a ready set of steps. See [Templates](templates.md).
- Click **Start a dot vote** in the toolbar for a single voting step with no template. It first asks what can be voted on (see [Dot voting](#dot-voting)); `Shift`-click the button to start at once on everything.
- Click **Start a quick poll** for a single poll step. See [Polls](polls.md).

When a board has steps but no session is running, the bar at the bottom shows **Session ready**, with the number of steps and the total minutes. Click **Start session** to begin at step 1, or **Edit steps** to change them first.

A board runs one session at a time. Adding a new template replaces the steps of the old one.

<!-- screenshot: the running session bar at the bottom of the board with step counter, timer and Next step button -->

## The session bar

While a session runs, the bar at the bottom shows:

- **Previous step** and **Next step** buttons. On the last step, **Next step** becomes **Finish**.
- The step count (for example 2/5), the step title, its mode and its instructions. Click it to open the full list of steps.
- A timer with **Start timer** or **Pause timer**, and **+1** to add a minute.
- Buttons specific to the step mode (see below).
- **Ask everyone to look here**, a button with a target icon. See [Focus requests](#focus-requests).

If a step is linked to a frame, the screen of the person who moves the session to that step flies to the frame. Everyone else gets a card that says who moved to which step, and chooses whether to go there. See [Focus requests](#focus-requests).

## Who can run a session

Anyone who can edit the board can start, move, pause and finish a session. There is no separate facilitator role, so agree in the room who drives. People who can only comment or view see the bar, but its buttons are disabled. If your workspace uses sign-in, see [Sharing, roles and teams](sharing.md).

## Edit the steps

Click the step name on the bar, or **Edit steps** on the **Session ready** bar. In the **Steps** list you can:

- Rename a step, set its minutes, and change its **mode**.
- Click the number to jump to that step.
- Click **Add step**. If a frame is selected on the board, the new step is linked to that frame.
- Remove a step with the trash button.
- Click **Summary** to download a Markdown summary of the session. It leaves out other people's private notes and the running vote's counts until you reveal them.
- Click **End session** to stop a running session.

### Step modes

| Mode | What it does |
|---|---|
| **Write** | Everyone adds notes normally. |
| **Private writing** | Notes are hidden from others until the reveal. |
| **Group** | A step for moving notes into groups. |
| **Dot vote** | Everyone places dots on notes. |
| **Discuss** | A step for talking. |
| **Poll** | Asks one question with a fixed list of answers. |

## Timer

Each step can have minutes. The timer starts paused when a step begins. Click **Start timer** to run it, **Pause timer** to stop it, and **+1** to add a minute. A timer under one minute turns to a warning style, and a chime plays when it reaches zero. Everyone sees the same time.

## Private writing

In a **Private writing** step, notes you create are visible only to you. Other people do not see what you wrote. Click **Reveal notes** on the bar to show everyone's notes at once. Moving to another step turns the reveal off again, but notes that were already revealed stay visible.

Other people's hidden notes are also left out of everything you can do with a selection: Select all, a drag selection, copy, duplicate, align, Arrange, recolouring, saving as a template, the AI bar and exports (board file, JSON, Mermaid). They come back after the reveal.

Comment pins on hidden notes are hidden as well. See [Comments](comments.md).

## Dot voting

**What can be voted on.** **Start a dot vote** opens a small panel with a choice and a count of the items:

- **Selected items** is the default when something is selected. It is the only way to vote on a frame, and it takes exactly the items you selected.
- **Everything** is every note, shape, card, text and image on the board. Frames, drawings, kanban columns and connectors are not included.
- **Sticky notes only**.

**Start vote** begins; **Start on everything** skips the choice. While the vote runs, the items that can take a dot have a dashed outline, and a click on anything else says it is not part of the vote.

In a **Dot vote** step:

1. Click an outlined item to add a dot. Click again to add more.
2. Hold `Shift` and click to remove one of your dots. On a touch screen there is no `Shift`: switch on **Remove dots** in the bar, then tap an item to take one of your dots back. Switch it off to add dots again. It turns itself off when the vote ends.
3. The bar shows how many dots you have left. Click it to set **Dots per person** (1, 2, 3, 5, 10, any number, or **No limit**). The change applies to everyone straight away, and dots already placed stay.
4. Click **Reveal votes** to show the totals.
5. Click **Copy results** to copy the ranked list as Markdown.

On a phone the vote bar is one compact row: **Reveal votes** (as an eye icon), **Remove dots**, your dots left, **Finish** and an **Info** button that shows the instructions. The step title, the timer and the other step buttons are hidden while a vote runs.

When the session ends, dots stay on the board. The bar shows **Vote results** with **Copy results** and **Clear dots** to remove them.

## Poll steps

On a phone a running poll uses a compact session bar (the answered count and its buttons) so the poll card and the bar both fit; the card and bar wait while Chat or Comments is open. The toast that says a poll or vote started sits above the card and the bar, and the **All steps** list re-places itself above the bar when you add a step, so **Next step** stays reachable.

A **Poll** step shows an answering card above the bar. The bar has **Reveal results**, then **Copy results** and **Add results to board**. Moving to the next step closes the poll. Details are in [Polls](polls.md).

## Focus requests

Nobody can move your view or make you follow them. To get people to look at something, you send a request, and each person decides what to do with it.

### Ask people to look

1. Move your view to what you want people to see.
2. Click **Ask everyone to look here** on the session bar. A message says "Asked everyone to look at your view".

Your own view does not change. The button is not limited to people who can edit, so viewers and commenters can ask too. After you ask, the button is disabled for 10 seconds and its tooltip counts down ("Ask again in 7 s"). Requests that arrive from the same person within 10 seconds of each other are ignored.

When a session moves to a step with a frame, only the person who moved it flies there. The others get a request that names the person and the step.

<!-- screenshot: the request card at the bottom of the board with Go to, Follow, Dismiss and Mute buttons -->

### When someone asks you

A card appears at the bottom of your screen: "Name asks you to look at their view", or "Name moved to step "Title"". It goes away on its own after 20 seconds. Up to three cards show at once. Choose one:

- **Go to** moves your view to where they were. You stay free to move away.
- **Follow** keeps your view on theirs as they pan and zoom. A chip says "Following Name. Pan, zoom or press Esc to stop." Following ends when you pan or zoom, press `Esc`, click **Stop**, or the other person leaves the board.
- **Dismiss** closes the card.
- **Mute Name** ignores their requests from now on.

You do not get a card for your own requests, or from someone you already follow.

### Mute and unmute

Mute is remembered for that person on that board, on this device only. When anyone is muted, the board menu shows **Muted people** with a count. Open it and click **Unmute** next to a name to see their requests again.

Outside a session, you can look at where someone else is by clicking their avatar in the top bar. This moves only your own view.

## Finish a session

Click **Finish** on the last step, or **End session** in the steps list. The timer stops and the bar goes back to idle. Steps that came from a quick vote or quick poll are removed; steps from a template stay, so **Session ready** appears again and you can run it once more.

## Hide the idle bar

When no session is running, the bar can show **Session ready**, **Vote results** and **Poll results**. To get it out of the way:

- Click **Hide** (the x), or
- Press `Esc`.

`Esc` hides the bar only when it has nothing else to do: nothing is selected, the **Select** tool is active, you are not dragging or editing text, no comment is open, and no field or dialog has focus. Otherwise `Esc` keeps its usual job.

Hiding changes nothing on the board and is remembered for you on this device only. **Session ready** returns when you open the steps list, add a template or start a session. **Poll results** return when someone starts a poll, when you click the poll tool, or when a newer poll closes. **Vote results** cannot be hidden: clear the dots instead. A running session's bar cannot be hidden.

## Restoring versions during a session

[Version history](version-history.md) refuses a restore while a session runs. Finish the session first.

## Related

- [Polls](polls.md)
- [Templates](templates.md)
- [Comments](comments.md)
- [Version history](version-history.md)
