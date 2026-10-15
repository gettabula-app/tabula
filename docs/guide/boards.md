# Boards and the home screen

The **Boards** page lists your boards and is where you create, open, import and delete them. It looks slightly different when your workspace uses sign-in.

## The Boards page

The top bar has the **Tabula** wordmark (click it to return here) and the **Boards** link. If your workspace uses sign-in, you also see your name, which is the account menu: your name and colour, **My templates**, **AI tool access** (if your administrator turned on AI tools), **Your AI key** (if you may use your own), chat notifications and **Sign out**. Workspace owners and admins also see **Admin**, and workspaces that have the tracker show a **Tracker** link.

Below the top bar:

- **New board** opens a menu. **Blank board** creates an empty board and opens it, **From a template…** opens the Templates page, and **Import a file…** creates a board from a `.drift` or `.json` file. See [Export and import](export-import.md).
- **Search boards** filters the list by title as you type.
- While you have no boards, a **Start from a template** row shows up to four templates, your own saved templates first, and an **All templates** link. Choose **Hide** to dismiss it on this device. See [Templates](templates.md).

![The Boards page of a signed-in member: a Design team section, Personal, and Shared with you with one View only board](images/teams-home.png)

## Open mode

If your workspace has no sign-in, the page shows one table, **Your boards**, with each board's name and when it was last edited. These boards are stored in this browser. A board you did not create appears here after you open its link once.

Click a board name to open it. A board that someone shared by link has the same address in the browser, so you can also bookmark it.

Open mode has no accounts, so anyone who can reach the server can open its boards. Use it only on your own computer or on a network you trust. For anything shared more widely, turn on sign-in; the server warns at startup when open mode listens on a network address.

## Workspaces with sign-in

When your workspace uses sign-in, the page groups boards:

- One section per team you belong to, with a badge showing whether you are an **Admin** or **Member** of it. **Manage** opens the team's settings, and **New board** in that section creates a board for the team.
- **Personal** holds boards you own that belong to no team.
- **Shared with you** holds boards that other people shared with you. For owners and admins, this section is called **Other boards**.
- **On this device** lists boards stored only in this browser. **Add to workspace** moves one to Personal or to a team, so others can reach it.

The table has an **Access** column. A badge appears only when your access is limited: **View only** or **Can comment**. No badge means you can edit.

The table also has a **Here now** column. It shows who has the board open right now, for boards you can open:

- Each other person is a small square with their initial and cursor colour. The first three people are shown, then **+N** for the rest. People appear in the order they joined.
- If you also have the board open in another tab, a **You** square follows the others. When nobody else is there, the cell is empty: your own presence alone shows nothing, and there is no "0".
- Point at the squares to see everyone's name. People who joined with a join code are marked **(guest)**.
- On a phone the squares are followed by a short text such as "Lin and 5 more". When the row has no room for a name, the text is left out.
- When someone leaves, their square stays for about three seconds, so a brief reconnect does not make it flicker.
- You only see people on boards you can open. AI tools never appear. People who joined with a join code do not see this column.
- It updates live through the chat connection. If chat is off on your server, the page checks again every 15 seconds.

Owners and admins also see **Members** and **New team** buttons. Other people, except guests, see **New team**. On a narrow screen these buttons are under the **…** button (More actions). For teams and roles, see [Sharing, roles and teams](sharing.md).

If your workspace has a banner message, it appears at the very top. If the server cannot be reached, a note says **You are offline. Showing the last list from this device.** and buttons that need the server are disabled.

## Notifications

In workspaces with sign-in, a bell sits in the top bar of the Boards page, next to your name. A badge on the bell counts what has not been read yet. It has a red outline when someone mentioned you. Open the bell to see the list, newest first:

- **Chat mentions**: someone mentioned you in a board, team or workspace chat.
- **Replies**: someone replied to a comment of yours.
- **Shares**: someone shared a board directly with you.
- **Team joins**: someone you invited joined the team, including when they signed in through your invite link.
- **Cards**: a card you own is due tomorrow, due today or overdue, or someone assigned you a card. Selecting the row opens the board.
- **Tracker**: tickets assigned to you, commented on and moved, if your workspace has the tracker.

Each row says who, what and where, with the first words of a message or comment, and when. Select a row to go there. Select the check on a row, or **Mark all as read**, to mark items read. Reading a chat clears its mention notices. **All** and **Mentions** filter the list, **Show older** loads more, and the list goes back 90 days. **Notification settings** has switches for what appears here (mentions, replies, cards and shares) and for the chat email, and it can send you one email a day listing what is new in your notifications (off until you turn it on).

An item disappears from the list, and from the count, when you can no longer open what it points to, for example after a board is unshared from you. The count updates live while chat is on, and every minute when chat is off. In open mode, without sign-in, there is no bell.

## Open a board

Click its name in the list. You can also paste a board link into the address bar. In a workspace with sign-in, you need access to the board for the link to work.

To go back, choose the **All boards** button (house icon) at the top left of the board.

## Rename a board

Click the board name at the top left of an open board, type the new name and press `Enter`. An empty name becomes **Untitled board**. On a board you can only view, the name is locked. Starting from a template names the board after the template, and you can rename it.

## Delete a board

Choose the trash icon at the end of a board's row, then confirm with **Delete board**.

- In open mode, and for boards under **On this device**, this removes the board from this device only. Copies on a sync server or on other people's devices remain.
- In a workspace with sign-in, only the board's owner sees the delete button. Deleting removes the board for everyone who has access. A workspace admin can restore it. See [Admin dashboard](admin.md).

## Board settings

In an open board, choose **Menu**, then **Board settings**. It is unavailable on view-only boards.

- **Grid.** Choose **Dots**, **Lines**, **Isometric** or **None**.
- **Grid size.** 8, 12, 16, 20, 24, 32, 40 or 48.
- **Snap to grid.** When on, moving and resizing snap to the grid. Hold `Alt` while dragging to ignore it for one move. Snapping is off in effect when the grid is **None**.
- **Heading font** and **Body font.** Used for new notes, shapes and frames.
- **Relay.** The sync server address. **auto** uses the server that serves the app, and **off** keeps the board on this device only. Changing it reloads the board. Leave it alone unless your administrator told you to change it.

These settings belong to the board and are shared with everyone on it.

## Board menu

The **Menu** button at the top right has these sections. Type in **Search actions** at the top of the menu (or press `/` while the menu is open) to find an action by name. **Appearance** and **Export** open as submenus beside the menu.

- **Account** (workspaces with sign-in): your name and email, **Sign out**, **Sign out everywhere**, and **Admin** for owners and admins. If your administrator turned on AI tools, **AI tool access** appears too. If they let you use your own AI key, **Your AI key** appears as well. See [Access tokens and AI tools](ai-tools.md) and [Your AI key](ai-keys.md).
- **Board**: **Board settings**, **Save board as template** ([Templates](templates.md)), **Version history** ([Version history](version-history.md)), **Your name and colour**, **Show comments** ([Comments](comments.md)), **Import a board file into this board**, and **Import Mermaid**.
- **Appearance**: the colour themes. See [Themes](themes.md).
- **Export** (or **Export selection** when something is selected): PNG, SVG, board file, JSON, Markdown summary, and **Copy as Mermaid**. See [Export and import](export-import.md).
- **Help**: **Keyboard shortcuts**.

Items that change the board are greyed out when you can only view it.

## Related

- [Getting started](getting-started.md)
- [Templates](templates.md)
- [Sharing, roles and teams](sharing.md)
- [Version history](version-history.md)
