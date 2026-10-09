# Your AI key

**Your AI key** lets you save your own Anthropic API key in Tabula. Once AI features are available, they use your key instead of the workspace key.

> Adding a key does not change anything in the app yet. The AI features that use it are still being built, so you cannot run AI features today.

## When you see it

**Your AI key** appears in the **Menu** under **Account**, and only when:

- your workspace uses sign-in, and
- a workspace owner or admin has turned on **Personal keys** in the [AI tab of the admin dashboard](admin.md#ai).

If the **Guests** setting is on, guests do not see it.

## Add a key

1. Open the **Menu** and choose **Your AI key**.
2. Paste your key into **API key**.
3. Select **Save key**.

**Save key** stays disabled until the key looks valid (no spaces). The provider checks the key before anything is stored, and the button reads **Checking…** meanwhile. If the check fails, the message says why and nothing is saved. A successful save shows **Key saved**.

## What you see afterwards

The dialog shows the provider, the last four characters of the key, and when it was added and last used. For example:

**Anthropic key ending …a1b2**

A line below it says when the key was added and when it was last used.

Your full key is never shown again, and the server never returns it. The line **Runs use your key.** tells you that your key is the one in use. If there is no key at all, the dialog says that AI features cannot run yet.

## Test a key

When your key is saved, select **Test key** next to **Remove**. Tabula asks Anthropic whether the saved key still works. The test does not show or replace your key, and it does not change the “last used” date. The message says **The key works.** when it succeeds, or explains what went wrong.

## Replace a key

Open **Your AI key**, paste a new key into **Replace with a new key**, and select **Save key**. The new key is checked the same way, and it replaces the old one once it is saved.

## Remove a key

1. Open **Your AI key**.
2. Select **Remove**. The button changes to **Click again to remove**.
3. Select it again.

Removing a key shows **Key removed**. If you click somewhere else before the second click, the button resets and nothing is removed.

## Models and provider

Tabula supports Anthropic only. The workspace admin chooses the model for the workspace, from:

- Claude Opus 5.5 (the default)
- Claude Sonnet 5.5
- Claude Haiku 5.5

You do not choose the model yourself.

> Board content is sent to the chosen provider and processed under its API terms. The dialog shows this notice.

The [AI bar](ai-bar.md), still in preview, is where these features run.
