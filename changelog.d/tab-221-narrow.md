section: Fixed

- AI previews on a narrow board (TAB-221, TAB-215): the short row of a preview whose stickies all changed no longer runs past the right edge at 360px wide, and a long runner name no longer pushes a label row off the board. The short row is never wider than the room right of the rail and wraps its label, and a stacked label row is cut with an ellipsis instead of overflowing (the full name stays in the row's accessible label).
- `npm run check:ai-review --runner <name>` runs the whole check with a long reviewer name, and its label-row check now also asserts the label itself is inside the view.
