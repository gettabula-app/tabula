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

- **Edit** changes the text of your own comment. Nobody can edit someone else's comment, not even a board owner. Edited comments show "edited" next to the time.
- **Delete** removes your own comment. Click it, then click **Click again to delete** to confirm.
- You cannot delete your own first comment while other people have replied to it, because that would remove their replies too.
- Moderators can delete anyone's comment. If your workspace uses sign-in, moderators are the board owner, workspace admins and the admins of the board's team. Without sign-in there are no moderators, so you can delete only your own comments.

### Imported and older comments

A comment brought in from a `.drift` or JSON file keeps its original author and shows an **imported** badge. Nobody can edit it. The person who imported it, or a moderator, can delete it.

If your workspace turned on sign-in after a comment was written, that comment shows a **legacy** badge. Nobody can edit it, and only a moderator can delete it.

### Resolve and reopen

You can resolve or reopen a thread if you wrote it or if you can edit the board. The **Resolve** button is hidden on other people's threads for everyone else, such as commenters.

### When a change is undone

If your workspace uses sign-in, the server checks every comment change against these rules. When it undoes one of yours, a message appears and the comment goes back to how it was:

- "Only the author can edit a comment, so that edit was undone."
- "Only the author or a moderator (a board owner or admin) can delete a comment, so that delete was undone."
- "Only the author or a board editor can resolve a comment, so that change was undone."
- "Comments are posted under your own account name, so that was corrected."

You see these only if something other than the normal buttons made the change, for example when your role changed while a thread was open. Comments are always posted under your account name.

## The Comments panel

Click the speech-bubble button in the top bar to open the **Comments** panel. A small number on the button counts the open threads.

- Use the **Open** and **Resolved** filters to switch lists. Each shows its count.
- Each row shows the first line of the thread, the number of replies and how long ago it was written.
- Click a row to fly to the pin and open the thread.

## Show or hide pins

Open the board menu and choose **Show comments** to switch pins on or off. A check mark means they are showing. The choice is remembered on this device only, and it does not delete anything.

Pins are never included in PNG or SVG exports. Comments are saved in `.drift` files and JSON exports, and restored when you import them, marked as **imported**. See [Export and import](export-import.md).

## Who can comment

| Role | Read comments | Add and reply | Resolve | Delete |
|---|---|---|---|---|
| Owner | Yes | Yes | Any thread | Any comment |
| Editor | Yes | Yes | Any thread | Your own |
| Commenter | Yes | Yes | Your own threads | Your own |
| Viewer | Yes | No | No | No |

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
