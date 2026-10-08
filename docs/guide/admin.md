# Admin dashboard

The admin dashboard is for workspace owners and admins. It shows who is in the workspace, what they have, who is signed in, and what changed. It exists only in workspaces with sign-in.

## Open the dashboard

Use any of these:

- **Admin** in the top bar of the home screen.
- **Admin** under **Account** in the board menu.
- The address `#/admin`.

Members and guests do not see these links and are sent back to the home screen if they open the address. Use the arrow at the top left to return to **Boards**.

The dashboard has a list of sections on the left. The address changes with the section, so reloading or going back returns you to the same one.

## Row actions need two clicks

Actions that remove access or data (**Disable**, **Remove**, **Sign out everywhere**, **Archive**, **Delete**, **Revoke**) are confirmed by clicking twice. The first click changes the button to **Click again**. Click again to run it. If you move away from the button, it resets and nothing happens.

Buttons you are not allowed to use are disabled, and hovering shows why. Only an owner can act on an owner, and the last owner cannot be demoted, disabled or removed.

After each action the row updates in place and a short message confirms it.

## Overview

Counts for the whole workspace:

- **Members**, by role, and **Disabled members**.
- **Teams**, with the number archived.
- **Boards**, with the number deleted.
- **Active sessions** and **Sign-ins, last 7 days**.
- **Live connections**, with the number of boards open right now.

Below the counts, **Instance** lists the server address, how email is sent, the version, and whether accounts are on.

On a hosted workspace, the owner also sees **Manage billing**. It opens the billing portal in the same tab, where you change the plan, add seats and update the payment method. Admins who are not owners do not see it.

<!-- screenshot: Overview section with the stat tiles and the Instance list -->

## Members

A searchable list of everyone with an account: name, email, role, last activity, active sessions, number of boards they own, and teams.

- Change someone's **Role** with the menu.
- **Disable** blocks sign-in and ends their sessions. **Enable** turns it back on.
- **Sign out everywhere** ends all of their sessions without disabling them. You can use it on yourself.
- **Remove** deletes the account, signs the person out and removes their access.

The role names are explained in [Sharing, roles and teams](sharing.md#roles). On a hosted workspace with a seat limit, enabling a person or promoting a guest can be refused when all seats are in use.

## Teams

Every team, including archived ones, with its member count. **Archive** hides a team from the home screen. Its boards stay available. **Unarchive** brings it back and needs no confirmation.

To rename a team or manage its people, use **Manage** on the home screen.

## Boards

Every board in the workspace: title, team (or **Personal**), and when it was last edited. Use the search box to filter by title.

- **Open** goes to the board.
- **Delete** removes the board for everyone who has access.
- Turn on **Show deleted** to list deleted boards, marked **Deleted**. Select **Restore** to bring one back. Restoring needs no confirmation.

As an admin you can open a deleted board to look at it. It opens read-only with a **Deleted board** badge until you restore it.

## Sessions

Each row is a sign-in: the person, when they signed in, when they were last seen, and when the session expires. **Revoke** ends one session and signs that device out. Your own session is marked **This session** and its button reads **Sign out**.

## Access tokens

Active [personal access tokens](ai-tools.md) for AI tools, across the workspace: whose it is, its name and access level, which boards it covers, when it was last used and when it expires. **Revoke** stops a token at once. The section appears only when AI tool access is turned on for your server.

## Audit log

A record of changes, newest first. Each entry reads as a sentence, for example who changed whose role. Actions the system takes on its own, such as the trial-ending notice to workspace owners, show **System** as the person. Hover an entry to see the underlying action name.

- Filter by **All**, **Members**, **Teams**, **Boards**, **Invites**, **Sign-ins** or **Sessions**.
- Select **Load more** to go further back.

Entries with no person are shown as the system, for example when a hosted workspace is locked or unlocked.

## Related

- [Sharing, roles and teams](sharing.md)
- [Access tokens and AI tools](ai-tools.md)
