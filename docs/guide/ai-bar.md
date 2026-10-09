# The AI bar (preview)

The AI bar is where you ask the AI to work on your board: summarise it, cluster stickies into groups, or generate ideas. It is still in preview and switched off by default. To try it, add `?aibar` to the board's address, for example `https://your-tabula/board/abc?aibar`. Tabula remembers the switch in that browser. Without it, none of this appears.

It also needs AI to be on for your workspace and a key to pay for it. See [Your AI key](ai-keys.md). Viewers and commenters do not see the bar, because they cannot add what it proposes.

## The bar

The bar sits at the bottom centre of the board. From left to right it has:

- A grip to move it. Drag to move, double-click to dock it again.
- **What the AI works on**: your selection (for example "3 stickies"), **Visible area**, **Whole board** or **Prompt only**, which sends no board content. The list shows how many stickies each choice covers.
- The prompt field, with a history button for recent prompts. It is optional for Summarise and Cluster, and it is the request itself for Generate.
- The model and an estimate of the cost, for example "Summarise · ~1.3k tokens". Select it to see the model your admin chose, who can see that you are asking, and "About 1,300 tokens go in; the reply is capped at 8,000. An estimate, not a bill."
- **Run**, and a button to collapse the bar.

Above them are the three actions as chips: **Summarise**, **Cluster** and **Generate ideas**. Selecting one arms it, and the bar shows its cost. A line at the bottom says what will be sent and who pays, for example "Sends 3 selected stickies to Anthropic. Uses the workspace key." On a phone the bar takes the full width and the model line moves down to that line.

Collapsing the bar leaves a small spark button, **Ask AI**. Select it, or press `Ctrl+K` (`Cmd+K` on a Mac), to open the bar again.

## Ask the AI

1. Open the bar with `Ctrl+K` (`Cmd+K` on a Mac) or `/`, or choose **Summarise**, **Cluster** or **Generate** from the menus.
2. Choose what the AI works on.
3. Pick an action, or type a request to generate ideas, then choose **Run** or press `Enter`.

While it works the bar says what it is doing, for example "Summarising 3 stickies…", and shows **Stop**. `Esc` also stops it. Nothing changes on the board until you add the result.

Everyone on the board sees that a run is under way, and then its result as a preview on the canvas, labelled "Your AI preview" for you and, for example, "Ana's AI preview" for others. Editors can add or discard anyone's preview. The first to act wins, and the others are told who did. A preview can land outside the part of the board you are looking at, so you may need to move the view to see it.

## When something goes wrong

The bar shows a message in place of the prompt, and nothing on the board changes:

- **No key:** the bar does not appear. If you are an admin, the board menu offers **Set up AI**.
- **The key was rejected:** "The AI key was rejected. Ask a workspace admin to check it."
- **Too many requests:** "Too many requests. Try again in 30 s." **Retry** stays greyed out until the countdown ends.
- **The provider is down or busy:** "Anthropic isn't responding. Try again in a moment."
- **The answer could not be used:** "The AI's answer could not be used. Nothing was changed."

Each message has **Retry** where it helps, and a button to dismiss it.

## The preview

When the AI has finished, the bar says what it would add, for example "3 stickies in a new frame “Summary”", and offers **Discard**, **Retry**, **Review** and **Add to board**. "Nothing is on the board until you add it. Enter adds, Esc discards."

## Review before you add

When a preview is ready, choose **Review**. A panel opens at the right of the board and lists every item the AI proposes, each with a box to keep it.

- **Generated or summarised stickies:** edit the text or the colour of each sticky, or untick it. A sticky with its text cleared is left out. A frame has a title and a box to leave it out, and needs at least one sticky.
- **Clusters:** each group has a title and a box, and each sticky it would move has a box. A group needs a title and at least one sticky left.
- **Changed since:** if a sticky has changed or gone since the AI looked at it, it is marked **Changed since**, unticked, and cannot be ticked. It stays where it is.

The main button reads **Add all** while everything is kept and **Add selected** (or **Move selected** for clusters) when you have left something out. **Discard** throws the preview away. Choosing **Add** with nothing kept says so and changes nothing.

Your edits are your own. Other people keep seeing the preview as the AI proposed it, and the preview on your screen shows exactly what you will add. Adding is one step in Undo, so `Ctrl+Z` takes back everything you added.

## Who proposed it

Select something the AI created and the properties panel says, for example, "Proposed by AI (Summarise) for Ana": which feature made it and who asked. Copies you save as a template do not keep this line.

## Not yet

Proposals that wait on the board for days, accepting a proposal while offline, proposals from outside AI tools, and several people editing one proposal together are coming.

## Related

- [Your AI key](ai-keys.md)
- [Access tokens and AI tools](ai-tools.md)
- [Export and import](export-import.md)
