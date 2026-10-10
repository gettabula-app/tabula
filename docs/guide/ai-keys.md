# Your AI key

**Your AI key** lets you save your own API key in Tabula: an Anthropic key, or a key for any service that speaks the OpenAI API (NVIDIA's catalogue, OpenAI, OpenRouter, or a model server of your own). When personal keys are allowed, AI uses your key in preference to the workspace key.

> AI can use a workspace key, or your key when an admin allows personal keys. AI also needs to be enabled for you. The board shows AI controls only when a key or plan credits are available.

## When you see it

**Your AI key** appears in the **Menu** under **Account**, and only when:

- your workspace uses sign-in, and
- a workspace owner or admin has turned on **Personal keys** in the [AI tab of the admin dashboard](admin.md#ai).

If the **Guests** setting is on, guests do not see it.

## Add a key

1. Open the **Menu** and choose **Your AI key**.
2. Choose the **Provider**: **Anthropic**, or **OpenAI-compatible**.
3. For OpenAI-compatible, fill in **Base URL** (where your provider's API lives, for example `https://integrate.api.nvidia.com/v1`) and **Model** (the model id your provider calls it, for example `moonshotai/kimi-k3`).
4. Paste your key into **API key**.
5. Select **Save key**.

**Save key** stays disabled until everything looks valid: no spaces in the key, a Base URL that starts with `https://` and is a public address (no user name or password, no `?` or `#`, not `localhost` or a private address), and a Model id. The provider checks the key before anything is stored, and the button reads **Checking…** meanwhile. For an OpenAI-compatible provider the check also asks the model for one word, so it can take up to half a minute with a slow model. If the check fails, the message says why (the key was refused, the model or the address is not known, or the model took too long) and nothing is saved. A successful save shows **Key saved**.

## What you see afterwards

The dialog shows the provider, the last four characters of the key, and when it was added and last used. For example:

**Anthropic key ending …a1b2**

For an OpenAI-compatible key the line also shows the provider's host and the model, for example **OpenAI-compatible key ending …a1b2 · integrate.api.nvidia.com · moonshotai/kimi-k3**. A line below it says when the key was added and when it was last used.

Your full key is never shown again, and the server never returns it. The line **Runs use your key.** tells you that your key is the one in use. If there is no key at all, the dialog says that AI features cannot run yet.

## Test a key

When your key is saved, select **Test key** next to **Remove**. Tabula asks the provider whether the saved key still works (and, for an OpenAI-compatible key, whether the model still answers). The test does not show or replace your key, and it does not change the “last used” date. The message says **The key works.** when it succeeds, or explains what went wrong.

## Replace a key

Open **Your AI key**, paste a new key into **Replace with a new key**, and select **Save key**. The new key is checked the same way, and it replaces the old one once it is saved.

## Remove a key

1. Open **Your AI key**.
2. Select **Remove**. The button changes to **Click again to remove**.
3. Select it again.

Removing a key shows **Key removed**. If you click somewhere else before the second click, the button resets and nothing is removed.

## Models and provider

Tabula supports **Anthropic** and **OpenAI-compatible** providers.

With an Anthropic key, the workspace admin chooses the model for the workspace, from:

- Claude Opus 5.5 (the default)
- Claude Sonnet 5.5
- Claude Haiku 5.5

You do not choose the model yourself.

With an OpenAI-compatible key, you choose the model: it is saved with your key and shown in the AI bar. Pick a model that follows instructions well, because Tabula asks for a JSON answer and uses it only when it is valid. When a model cannot do that, the AI bar says so, for example **This model did not answer in the required JSON format. Try a stronger instruction-following model.**, and nothing on the board changes. A model can also be slow (the AI bar then says it took too long) or missing from the provider's list (**The provider does not know this model or this address**). The AI bar shows a token estimate but no price for these models: Tabula does not know it, and your provider bills your key.

> Board content is sent to the chosen provider and processed under its API terms. The dialog shows this notice.

The [AI bar](ai-bar.md) is where these features run.
