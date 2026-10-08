# Access tokens and AI tools

An access token lets an AI tool such as Claude Code work with your boards on your behalf. The tool can read boards, comment, and, if you allow it, edit them while other people watch the changes appear.

> This feature must be turned on by whoever runs your Tabula server. If **AI tool access** is missing from your board menu, ask them to enable it. It is available in workspaces with sign-in.

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

1. Open the board menu and choose **AI tool access** under **Account**.
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
