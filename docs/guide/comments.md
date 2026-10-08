# Comments

Comments are threaded notes pinned to a place on the board or to an object. Use them for questions and feedback that should not clutter the board itself.

## Add a comment

1. Press `C`, or click **Comment** in the toolbar.
2. Click a place on the board, or click an object. A box opens.
3. Type in **Add a comment** and press `Enter`. Use `Shift+Enter` for a new line.

The thread is created when you post the first message. If you press `Esc` or click **Cancel**, nothing is saved. After you place a pin, the tool switches back to **Select**, so you press `C` again for the next one.

<!-- screenshot: a comment pin on a sticky note with its thread open, showing one reply and the Resolve button -->

A pin placed on an object stays attached to it when you move, resize or rotate the object. A pin placed on empty canvas stays where you put it. If the object is deleted, the pin stays at its last position.

Typing in a comment box never triggers board shortcuts, so you can use any letters freely.

## Read and reply

- Click a pin to open its thread. You can do this on any board you can open, including a read-only one.
- Type in **Reply** and press `Enter`, or click **Reply**.
- Click **Resolve** when the question is settled. Resolved pins fade. Click **Reopen** to bring the thread back.
- Click outside the thread, or press `Esc`, to close it.

## Edit and delete

- **Edit** changes the text of your own comment. Edited comments show "edited" next to the time.
- **Delete** removes your own comment. Click it, then click **Click again to delete** to confirm.
- You cannot delete your own first comment while other people have replied to it, because that would remove their replies too.
- Board owners can delete anyone's comment.

## The Comments panel

Click the speech-bubble button in the top bar to open the **Comments** panel. A small number on the button counts the open threads.

- Use the **Open** and **Resolved** filters to switch lists. Each shows its count.
- Each row shows the first line of the thread, the number of replies and how long ago it was written.
- Click a row to fly to the pin and open the thread.

## Show or hide pins

Open the board menu and choose **Show comments** to switch pins on or off. A check mark means they are showing. The choice is remembered on this device only, and it does not delete anything.

Pins are never included in PNG or SVG exports. Comments are saved in `.drift` files and JSON exports, and restored when you import them. See [Export and import](export-import.md).

## Who can comment

| Role | Read comments | Add, reply, resolve |
|---|---|---|
| Owner, editor | Yes | Yes |
| Commenter | Yes | Yes |
| Viewer | Yes | No |

A **commenter** can comment but cannot change the board. This suits a stakeholder who reviews your work. Viewers see the pins and threads; the **Comment** tool is disabled for them, and an open thread says "You can read comments on this board but not add them."

If your workspace does not use sign-in, everyone can comment. See [Sharing, roles and teams](sharing.md) for how to give someone a role.

## Private writing and comments

During a session's private writing step, other people's hidden notes stay hidden. A pin on a hidden note is hidden too, and its thread cannot be opened. Placing a pin on a hidden note leaves the pin on the canvas instead of attaching it. See [Sessions and focus requests](sessions.md).

## Comments and undo

Comments are separate from the board's undo history. `Ctrl+Z` (`Cmd+Z` on Mac) never removes a comment, and [restoring a version](version-history.md) does not change comments.

## Related

- [Sharing, roles and teams](sharing.md)
- [Version history](version-history.md)
- [Export and import](export-import.md)
