section: Fixed

- AI key screens with an OpenAI-compatible provider (TAB-222): the admin Provider select now has its chevron like the Model select (it read as a text box), the Base URL and Model fields are spaced the same on both screens with each hint next to its own field, and an empty provider group no longer leaves a gap in the Anthropic form. Found by looking at both dialogs at 390 and 1024 wide.
- `npm run visual` has states for both key screens, with each provider, a bad address and a saved key (`ai-key-me*`, `ai-admin*`).
