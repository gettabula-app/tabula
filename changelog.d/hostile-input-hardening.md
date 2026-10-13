section: Fixed

- Very long unbroken words or code lines in Markdown blocks and table cells no longer slow the board down: long words are cut at 2,000 characters, and a Markdown block holds at most 8,000.
- Two people adding a table row or column at the same moment can no longer stop later inserts and moves in that table.
- Templates hold at most 500 objects and 200,000 characters of text, and templates with tables keep their cells when saved to the server.
- Files and exports with control characters in text no longer produce unreadable SVG, and a table copied as text no longer runs a cell as a spreadsheet formula.
