# Sessions and focus requests

A session is a facilitated sequence of timed steps that you run on the board, such as writing, grouping, voting and discussing. Everyone on the board sees the same step and the same timer.

## Start a session

You can begin a session in three ways:

- Add a session template from **Templates and team exercises** in the toolbar. Retrospective, brainstorm, prioritisation and planning templates come with frames and a ready set of steps. See [Templates](templates.md).
- Click **Start a dot vote** in the toolbar for a single voting step with no template.
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
- **Bring everyone to my view**.

If a step is linked to a frame, everyone's view moves to that frame when the step starts.

## Who can run a session

Anyone who can edit the board can start, move, pause and finish a session. There is no separate facilitator role, so agree in the room who drives. People who can only comment or view see the bar, but its buttons are disabled. If your workspace uses sign-in, see [Sharing, roles and teams](sharing.md).

## Edit the steps

Click the step name on the bar, or **Edit steps** on the **Session ready** bar. In the **Steps** list you can:

- Rename a step, set its minutes, and change its **mode**.
- Click the number to jump to that step.
- Click **Add step**. If a frame is selected on the board, the new step focuses everyone on it.
- Remove a step with the trash button.
- Click **Summary** to download a Markdown summary of the session.
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

Comment pins on hidden notes are hidden as well. See [Comments](comments.md).

## Dot voting

In a **Dot vote** step:

1. Click a note or shape to add a dot. Click again to add more.
2. Hold `Shift` and click to remove one of your dots.
3. The bar shows how many dots you have left. Click it to set **Dots per person** (1, 2, 3, 5, 10, any number, or **No limit**). The change applies to everyone straight away, and dots already placed stay.
4. Click **Reveal votes** to show the totals.
5. Click **Copy results** to copy the ranked list as Markdown.

When the session ends, dots stay on the board. The bar shows **Vote results** with **Copy results** and **Clear dots** to remove them.

## Poll steps

A **Poll** step shows an answering card above the bar. The bar has **Reveal results**, then **Copy results** and **Add results to board**. Moving to the next step closes the poll. Details are in [Polls](polls.md).

## Bring everyone to my view

Click **Bring everyone to my view** on the bar. Everyone else's screen moves to the centre of your view at your zoom level, and a message says "Everyone is now looking where you are." Your own view does not change. People can pan away afterwards.

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
