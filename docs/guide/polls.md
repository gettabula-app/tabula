# Polls

A poll asks everyone on the board one question with a fixed list of answers. You can start one in a few seconds from the toolbar, or add one as a step in a [session](sessions.md).

## Start a quick poll

1. Click **Start a quick poll** in the toolbar on the left.
2. Type the question in **Ask a question**. It can be up to 200 characters.
3. Fill in the options. A poll has 2 to 10 options, each up to 120 characters. Click **Add option** for more, or the **x** beside an option to remove it. Options must have text and must differ from each other.
4. Choose how people answer:
   - **More than one answer**: people can tick several options. Without it, each person picks one.
   - **Anonymous (names stay hidden)**: on by default. Turn it off to show who chose what in the results.
5. Click **Start poll**, or press `Ctrl+Enter` (`Cmd+Enter` on Mac).

<!-- screenshot: the quick poll form with a question and three options filled in -->

The poll opens at once for everyone on the board. If a session is already running, the poll is added right after the current step and the session moves to it. If no session is running, the poll is added at the end of the board's steps and the session starts on it.

Only one poll can be open at a time. If you try to start another, you see "A poll is open. Finish it or move on first."

## Add a poll to a session

1. Open the steps list: click **Edit steps** on the **Session ready** bar, or click the step name on the running bar.
2. Add a step with **Add step**, or pick an existing one.
3. Set its mode to **Poll**. The poll form opens.
4. Click **Save poll**.

The step takes the question as its title. To change the poll later, click **Edit poll** next to the step. Once a poll has opened, its question and options are locked. See [Sessions and focus requests](sessions.md) for how steps run.

## Answer a poll

When a poll step is running, a card appears above the session bar with the question and the options.

- Click an option to answer. Your answer saves as you choose.
- With **More than one answer**, click an option again to untick it.
- To change your answer, pick a different option. You can change it until the poll closes.
- Click **Clear my answer** to take your answer back.

Next to the card title, **N of M answered** shows how many people have answered out of the people currently on the board. Each person counts once, even with two tabs open.

If you can only view the board, the card tells you "View only. Only people who can edit the board can answer." See [Sharing, roles and teams](sharing.md) for roles.

## Close a poll

A poll is open while its step is the running step. It closes when the session moves to another step, or when the session ends. After that, nobody can change an answer.

## Reveal the results

Results stay hidden while people answer, so nobody is influenced by the count. Whoever runs the session decides when to show them.

1. Click **Reveal results** on the session bar. You can do this while the poll is open or after it has closed.
2. The card now shows **Ranked results**: each option with its count and percentage, most chosen first. Ties keep the order you wrote the options in.
3. If the poll is not anonymous, the names of the people who chose each option appear under it.

Everyone sees the results at the same time. Revealing cannot be undone, but you can clear the whole poll (see below).

## Copy or keep the results

After the results are revealed, two buttons are available on the session bar:

- **Copy results** copies the question and the ranked options as Markdown, ready to paste into a document.
- **Add results to board** puts a sticky note on the board with the question and the ranked list. It is placed to the right of your existing content. The note is a snapshot: it does not change if the poll does.

Both are refused until the results are revealed ("Reveal the results first.").

The **Markdown summary** in the board menu also lists every poll that has opened. Polls that were not revealed show "Results not revealed."

## After the session

When the session ends, the bar keeps a **Poll results** block for the latest poll. It shows the question and the number of responses, with these buttons:

- **Copy results** and **Add results to board** (available once the results are revealed).
- **Reveal results**, if you did not reveal them during the session.
- **Clear poll** removes the poll, its answers and its step from the board.
- **Hide** (the x) hides the block on your screen only. It comes back when someone starts a poll or uses the poll tool, and when a newer poll closes.

On a phone, the poll card and its controls wait out of the way while Comments or Chat is open, and come back when you close the tray.

## Who can do what

- Anyone who can edit the board can start a poll, answer, reveal and clear.
- Commenters and viewers can see the poll card and the results once revealed, but cannot answer.
- In an anonymous poll, names are never shown in the results.

## Related

- [Sessions and focus requests](sessions.md)
- [Sharing, roles and teams](sharing.md)
- [Export and import](export-import.md)
