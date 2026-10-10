# Access tokens and AI tools

An access token lets an AI tool such as Claude Code work with your boards on your behalf. The tool can read boards, comment, and, if you allow it, edit them while other people watch the changes appear.

> This feature must be turned on by whoever runs your Tabula server. If **AI tool access** is missing from the top bar and the board menu, ask them to enable it. It is available in workspaces with sign-in.

## What an AI tool can do

What the tool can do depends on the level you give the token.

- **Read only**: list your boards, read a board's contents and read its comments.
- **Read and comment**: also add comments and reply to them. Comments are marked with your name followed by the token name, so people can tell them from comments you typed.
- **Read and edit**: also create, change and delete objects on the board. These edits appear live for everyone on the board.

An AI tool cannot share boards, change roles, delete boards, manage teams or see the member list.

Two safeguards apply to every token:

- A token never has more access than you do. If you are only a viewer on a board, the tool can only read it, even with an edit token. If your access is removed, the token loses it too.
- Private notes from a running [session](sessions.md) are withheld. The tool does not see them, and cannot change or delete them.

> A person's `Ctrl+Z` (`Cmd+Z` on Mac) does not undo an edit made by an AI tool. Deleting through a tool is permanent, so give edit access only where you need it. Board text is passed to the AI tool, so only connect tools you trust with that content.

## Create a token

Admins can also select **Create a token** in the **Access tokens** section of Admin. It opens this same form and makes a token for you, and the list there refreshes.

1. Choose **AI tool access** in the top bar of the **Boards** or **Templates** page, or open the board menu and choose it under **Account**.
2. Select **New token**.
3. Enter a **Name**, for example "Claude Code on my laptop".
4. Pick an **Access** level: **Read only**, **Read and comment** or **Read and edit**. Choose the lowest level the tool needs.
5. Under **Boards**, choose **All my boards** or **Only these** and tick the boards (up to 20).
6. Choose when the token **Expires**: 7, 30, 90 or 365 days. There is no token that never expires.
7. Select **Create token**.

<!-- screenshot: New token form in the AI tool access dialog, with Read and comment and Only these selected -->

The token is shown once. Copy it now and treat it like a password. If you lose it, revoke it and make another. The dialog also gives you a ready-made command and a settings snippet for your tool.

### Owners and admins must name boards

Workspace owners and admins have full access to every board. For that reason, an owner's or admin's **Read and comment** or **Read and edit** token must list its boards with **Only these**. **Read only** tokens can cover all boards. If you are promoted to admin after creating an unrestricted comment or edit token, it acts as read only until you are a member again.

## Connect Claude Code

Paste the command from the dialog into your terminal. It has this form:

```
claude mcp add --transport http board https://YOUR-SERVER/mcp --header "Authorization: Bearer YOUR-TOKEN"
```

Other tools use a settings file with the same details:

```
{
  "mcpServers": {
    "board": {
      "type": "http",
      "url": "https://YOUR-SERVER/mcp",
      "headers": { "Authorization": "Bearer YOUR-TOKEN" }
    }
  }
}
```

The server address is the one you use for Tabula, followed by `/mcp`. Once connected, ask the tool to list your boards or read one.

## What an editing tool may change and delete

A tool with **Read and edit** can create sticky notes, shapes, text, frames and connectors. It can only change the properties each kind of object has: a field that does not belong to that object, or an attempt to change its kind, is refused and nothing is saved. A group can be renamed but not restyled, and images, icons and drawings can be moved, resized, rotated and put in or taken out of a frame or group.

Kanban boards need care:

- A tool cannot change a kanban card through the ordinary edit tool: it has to use the card tools below. It cannot change lanes or labels through the ordinary edit tool either: it uses the lane and label tools below. It cannot create or change a kanban itself; do that in the app.
- A tool cannot delete a kanban, and deletes a lane only with the lane tool below. It can delete a card that you can see, that is in a lane and is not locked. A card owned by another AI tool cannot be deleted by this one. A card that is hidden, or holds private session notes you cannot see yet, answers as if it does not exist.
- Deleting a group deletes everything in it, including groups, frames and kanbans inside it, but a single locked item in the group stops the whole delete ("A member of this group is locked. Unlock it to delete the group."). Private notes from a running session that are not yet revealed are left on the board.
- A delete that covers several objects is all or nothing, and connectors attached to deleted objects go with them.

## Kanban cards from an AI tool

A tool with a token can work with the cards of a [kanban board](kanban.md) as well as with ordinary objects. The tools are:

| Tool | What it does | Needs |
|---|---|---|
| `list_kanban_cards` | Lists the cards of a kanban in order: title, description, lane, stage, owner, due date, link and label names, plus the visible lanes with their stage, work in progress limit and card count | Read only or more |
| `add_kanban_card` | Adds a card to a lane, or to the first lane with a stage (to do, doing or done) | Read and edit |
| `update_kanban_card` | Changes a card's title, description, due date, labels, link or owner | Read and edit |
| `move_kanban_card` | Moves a card to another lane, or to the first lane with a stage | Read and edit |

A tool cannot create a kanban: do that in the app. It can use only labels that exist on the board, up to 10 on a card (it can make labels with the label tools below). It must name the lane or the stage, not both.

What a tool is allowed to put on a card:

- A **title** of up to 200 characters and a **description** of up to 4,000.
- A **due date** that is a real calendar date, written like `2026-11-05`.
- A **link** that is a web address starting with `http://` or `https://`, up to 2,000 characters, with no spaces and no user name or password. Other kinds, such as `javascript:`, are refused and no card is made.
- An **owner**: a name for a person, or itself as an AI tool. A tool cannot assign a person's account. A card the tool owns shows the eight-sided badge, and only that token can change who owns it.

A lane that blocks work in progress refuses a new or moved card when it is full, and a locked card cannot be changed. Cards appear on the board for everyone at once. They are made outside Undo, like other edits by tools, so remove a mistake with **Delete** on the card, or ask the tool to delete it (a tool can delete a card a person made, but not a card that another AI tool owns). Cards made this way settle to their true height when an editor has the board open; on a board that only viewers have open they keep a default height, so a label or date may look clipped until an editor opens it.

### Lanes and labels

With **Read and edit**, a tool can also set up the lanes and labels of a kanban that already exists in the app. A tool still cannot create the kanban itself.

| Tool | What it does |
|---|---|
| `create_kanban_label` | Adds a label with a name (1 to 40 characters, no duplicates ignoring capitals) and a colour, a palette name or a `#` hex code; the first unused palette colour if none is given. A board has at most 30 labels |
| `update_kanban_label` | Renames a label or changes its colour |
| `delete_kanban_label` | Deletes a label, removes it from every card that has it, and says how many cards changed |
| `add_kanban_lane` | Adds a lane with a name (1 to 60 characters), optionally a stage (to do, doing or done), a work in progress limit (1 to 99), whether the limit blocks, and where it goes in the order. A kanban holds up to 20 lanes, hidden ones included |
| `update_kanban_lane` | Renames, restages, reorders or hides a lane, and sets or clears its stage and limit. A tool cannot show a hidden lane again, because a hidden lane is invisible to it; do that in the app |
| `delete_kanban_lane` | Deletes a lane. A lane with cards needs a lane to move them to: they go in order to the end of that lane, even cards owned by another AI tool |

Rules that apply:

- A blocking limit needs a limit. Lowering a limit below the number of cards the lane already holds is allowed, and the tool is told it is over the limit.
- A locked lane cannot be changed, and lanes in a locked kanban cannot be reordered.
- The last visible lane cannot be hidden or deleted.
- A lane cannot be deleted if it holds a locked card, or if the lane that would receive its cards blocks and would go over its limit.
- Hidden lanes and private cards still answer as if they were not there.

## Signing in with OAuth

Today a tool connects with a token, as above. Connecting from a tool's own **Add connector** screen with OAuth is **coming soon**, not available yet. Until then, use the command or settings file from the token dialog.

## Manage your tokens

**AI tool access** lists your tokens with their name, level, boards, expiry and when each was last used, plus the last four characters of the token so you can tell them apart.

- **Revoke** stops one token. Click twice to confirm.
- **Revoke all** stops every token you own.
- You can have up to 20 active tokens.

Revoking takes effect on the tool's next request. Signing out of Tabula does not revoke tokens, so revoke a token when you stop using a tool.

Workspace owners and admins can see and revoke everyone's tokens in the **Access tokens** section of the [admin dashboard](admin.md#access-tokens). If your workspace is read-only, you cannot create tokens, but you can still revoke them.

## Related

- [Sharing, roles and teams](sharing.md)
- [Admin dashboard](admin.md)
- [Comments](comments.md)
- [Sessions and focus requests](sessions.md)
