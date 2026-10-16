# Boards and the home screen

The **Boards** page lists your boards and is where you create, open, import and delete them. It looks slightly different when your workspace uses sign-in.

## The Boards page

The top bar has the **Tabula** wordmark (click it to return here) and the **Boards** link. If your workspace uses sign-in, you also see your name, which is the account menu: your name and colour, **My templates**, **AI tool access** (if your administrator turned on AI tools), **Your AI key** (if you may use your own), chat notifications and **Sign out**. Workspace owners and admins also see **Admin**, and workspaces that have the tracker show a **Tracker** link.

Below the top bar:

- **New board** opens a menu. **Blank board** creates an empty board and opens it, **From a template…** opens the Templates page, and **Import a file…** creates a board from a `.drift` or `.json` file. See [Export and import](export-import.md).
- **Search boards** filters the list by title as you type.
- In a workspace with sign-in, boards are cards, with a **Cards | List** switch and a **Show previews** switch. See [Workspaces with sign-in](#workspaces-with-sign-in). While you have no boards, template cards help you start: see [First run](#first-run).

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

Owners and admins also see **Members** and **New team** buttons. Other people, except guests, see **New team**. On a narrow screen, **New team** and **Members** sit behind the **More actions** button, shown as three dots. For teams and roles, see [Sharing, roles and teams](sharing.md).

If your workspace has a banner message, it appears at the very top. If the server cannot be reached, a note says **You are offline. Showing the last list from this device.** and buttons that need the server are disabled.

### Cards and list

Each board is a card. At the top, **Cards | List** switches between a grid of cards and a list with one row per board. **Show previews** turns the pictures on the cards on or off. Both choices are remembered on this device.

A card shows:

- A picture of the board, or a plain tile when there is none. A board with nothing on it yet says **No content yet** under its name.
- The board's name, which opens it, and a line under it: who edited it last and when ("Lin · 12 min ago"; an AI tool is marked "(agent)"), or "Edited 3 Oct" when the server does not name the person, or "On this device".
- Who is here now (see below).
- A badge when your access is limited: **Viewer** or **Commenter**. No badge means you can edit.
- On the picture, a small number for the unread chat messages of that board, highlighted when someone mentioned you. It shows only when chat is on.
- A **More actions** menu (three dots). Everyone can choose **Open**. Editors can also **Rename** and **Duplicate**, and the owner can also **Delete**. A board that is only on this device offers **Open**, **Add to workspace** and **Delete**.

In the list view each board is a row with its name, **Here now**, **Last edited** and **Access** columns. On a narrow screen the extra columns are left out.

**Here now** shows who has the board open right now, for boards you can open:

- Each other person is a small square with their initial and cursor colour. The first three people are shown, then **+N** for the rest. People appear in the order they joined.
- If you also have the board open in another tab, a **You** square follows the others. When nobody else is there, nothing shows: your own presence alone shows nothing, and there is no "0".
- Point at the squares to see everyone's name. People who joined with a join code are marked **(guest)**.
- On a phone the squares are followed by a short text such as "Lin and 5 more". When there is no room for a name, the text is left out.
- When someone leaves, their square stays for about three seconds, so a brief reconnect does not make it flicker.
- You only see people on boards you can open. AI tools never appear. People who joined with a join code do not see this.
- It updates live through the chat connection. If chat is off on your server, the page checks again every 15 seconds.

### Pictures on cards

The picture is a small copy of what is on the board, made by the browser of a person who can edit it. When an owner or editor has the board open and changes it, their browser draws the picture and sends it to the server, with every image on the board shrunk to at most 480 pixels first. People who can only view or comment never make a picture. Until a board has one, its card shows a drawn outline of the board, or a plain tile when the board is empty.

Everyone who can see a board's card sees its picture. That includes what is on the board, so a board whose content should stay out of sight should not show one:

- **Show previews** at the top of the page hides all pictures for you, on this device.
- The owner of a board, and a workspace admin, can open the board menu and turn **Show a picture on the card** off. Then the card shows a plain tile, and the picture saved for that board is deleted. Nobody else sees this switch.
- A workspace admin can turn board pictures off for the whole workspace in **Admin**, under **Privacy**. Whoever runs your Tabula server can also switch them off for the whole server; the server's own documentation says how.

### First run

When you have no boards, the page says **No boards yet** and offers **New board**. In a workspace with sign-in it also shows **Start your first board**: cards for the built-in templates and a **Blank board** card. Choose a card to open a new board from it. **Skip, start with a blank board** opens an empty board, and **Hide** removes the suggestions on this device. They go away on their own once you have a board.

A team with no boards shows **No boards in** the team's name **yet**, with **New board** for people who may add boards there, and **No boards shared with you yet** appears in the shared section.

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

In a workspace with sign-in, open the **More actions** menu (three dots) on the board's card or row and choose **Delete**. In open mode, choose the trash icon at the end of the board's row. Then confirm with **Delete board**.

- In open mode, and for boards under **On this device**, this removes the board from this device only. Copies on a sync server or on other people's devices remain.
- In a workspace with sign-in, only the board's owner is offered **Delete**. Deleting removes the board for everyone who has access. A workspace admin can restore it. See [Admin dashboard](admin.md).

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
