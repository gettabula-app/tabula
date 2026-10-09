section: Fixed

- "Your AI key" at 360px wide: the Provider select cut its own label under the chevron ("OpenAI-compatible (NVIDIA, OpenAI, OpenRouter, loca"). The option now reads "OpenAI-compatible" and the examples (NVIDIA, OpenAI, OpenRouter, a server of your own) are in the Base URL hint (TAB-222).
- Both key screens were checked in the other four themes and by keyboard only: Tab reaches the Provider select, typing `O` chooses OpenAI-compatible and shows the Base URL and Model fields, Tab runs through them to Save key in reading order, and the focused field shows a focus indicator. `npm run visual` has `ai-key-me-keyboard` and `ai-admin-keyboard` to repeat that.
