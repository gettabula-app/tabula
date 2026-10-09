# Version history

Version history lets you look at earlier states of a board, preview one without changing anything, and restore it. Use it to recover from a mistake or to go back to a milestone.

## Open version history

Open the board menu and choose **Version history**. It is in the **Board** group, below **Board settings**. A panel opens on the right.

The menu item is shown to owners and editors, and to everyone when your workspace has no sign-in. Commenters and viewers do not see it.

Version history is stored on the server. If you are offline, or the board is not connected to a server, the panel says "Version history is stored on the server and needs a connection."

<!-- screenshot: the Version history panel with a named version, automatic versions grouped under Today, and the All / Named tabs -->

## Automatic and named versions

The list shows versions newest first, grouped by day. The top row, **Current board**, is the live board. Each version shows its time, a title and how many objects the board had, with the change from the neighbouring version, so a sudden drop is easy to spot.

- **Automatic version**: saved for you while people edit, roughly every 10 minutes at most, when the last person leaves the board, and just before a large deletion.
- **Named version**: one you save yourself with a name, such as "Before the workshop".
- **Before restore** and **Restored a version**: saved around a restore (see below).

Use the **All** and **Named** tabs to filter the list.

### Save a named version

1. Click **Save version** at the top of the panel.
2. Type a name (up to 80 characters).
3. Click **Save**.

You can also name an automatic version: select it and click **Name**, or **Name this version** in the preview. Select a named version and click **Rename** to change its name. If you have not added anything to the board yet, you see "Nothing to save yet."

## Preview a version

1. Click a version in the list, or use the arrow keys and press `Enter`.
2. The board is covered by a read-only view of that version, with a banner reading **Viewing version**.
3. Drag to pan, scroll to zoom, or click **Fit to content**.
4. Click **Back to current board**, or press `Esc`, to leave the preview.

The preview does not change the board. It does not show comments, cursors or selection. Keyboard shortcuts do not reach the board while you preview.

## Restore a version

1. Preview the version you want.
2. The banner tells you what a restore would do, for example "Restoring adds 4, changes 7, removes 12 items".
3. Click **Restore this version**.
4. Confirm in **Restore this version?** by clicking **Restore**.

Everyone on the board sees it change. A toast says "Version restored. Press Ctrl+Z to undo."

What happens:

- The board as it is now is saved first as a **Before restore** version, so you can always go back to it from the list.
- The restore itself is one ordinary edit. Press `Ctrl+Z` (`Cmd+Z` on Mac) to undo all of it in one step, in the tab where you restored. This works until you reload the page; the **Before restore** version lasts longer.
- It then appears in the list as **Restored a version**.

### What is not restored

A restore changes the objects on the board and the board settings such as the grid. It leaves these alone:

- The board's name.
- The running session, and any votes.
- Comments. Pins for objects that come back reattach to them; pins for objects that are removed stay in place.
- Notes that other people are hiding in a private writing step.

### When restore is unavailable

The **Restore this version** button is disabled, with a reason, when:

- A session is running: "Finish the running session before restoring a version."
- You can only view the board, or your workspace is read-only.
- The version was made with a newer version of Tabula than the one you are using.

If the version matches the board as it is, the banner says "This version matches the board as it is now."

## Delete a version

Select a version and click **Delete**, then click **Confirm delete**.

- Board owners can delete any version.
- Editors can delete only the named versions they saved.
- Owners can rename any named version. Editors can name an unnamed version, and rename named versions they saved.

Version history keeps content people deleted from the board, [pictures](images.md#deleting-a-picture) included. If something sensitive was on the board, delete every version that still contains it.

## How long versions are kept

- Automatic versions: all of them for 24 hours, then one per hour for up to 7 days, then one per day up to 30 days. After 30 days they are deleted.
- **Before restore** and **Restored a version**: 30 days.
- Named versions: until you delete them, up to 100 per board.

Each board also has a storage limit. If a very busy board reaches it, the oldest automatic versions go first. The newest version is always kept.

## Who can use it

| Role | See and preview | Save, name, restore |
|---|---|---|
| Owner | Yes | Yes |
| Editor | Yes | Yes |
| Commenter | No | No |
| Viewer | No | No |

In a workspace without sign-in, everyone can use it. See [Sharing, roles and teams](sharing.md).

## Related

- [Export and import](export-import.md): keep a copy of the board as a file.
- [Sessions and focus requests](sessions.md)
- [Comments](comments.md)
