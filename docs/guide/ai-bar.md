# The AI bar (preview)

The AI bar is where you ask the AI to work on your board: summarise it, cluster stickies into groups, or generate ideas. It is still in preview and switched off by default. To try it, add `?aibar` to the board's address, for example `https://your-tabula/board/abc?aibar`. Tabula remembers the switch in that browser. Without it, none of this appears.

It also needs AI to be on for your workspace and a key to pay for it. See [Your AI key](ai-keys.md). Viewers and commenters do not see the bar, because they cannot add what it proposes.

## Ask the AI

1. Open the bar with `Ctrl+K` (`Cmd+K` on a Mac) or `/`, or choose **Summarise**, **Cluster** or **Generate** from the menus.
2. Choose what the AI works on: your selection, the visible area or the whole board.
3. Pick an action, or type a request to generate ideas, then choose **Run** or press `Enter`.

While it works you can choose **Stop**. Nothing changes on the board until you add the result.

Everyone on the board sees that a run is under way, and then its result as a preview on the canvas in the runner's colour, for example "Ana's AI preview". Editors can add or discard anyone's preview. The first to act wins, and the others are told who did.

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
