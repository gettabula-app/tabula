section: Changed

- Opening a board file made by another account, and pasting objects copied from another board, now makes you the author of what comes in.
  Card owners who are not on the board are cleared (their name stays as text), and tracker links, tracker frames' workspace links and AI attributions in a file are left behind.
  Tables and Markdown blocks come in like every other object: authored by you, with no owner, tracker link or AI attribution, every row, column, width and cell kept as it was, and Remove imported content leaves a table in which you changed even one cell.
  A table with more rows, columns or text than the table editor allows (100 rows, 30 columns, 150,000 characters) is refused with a message instead of being sent to the server and taken back; a paste leaves such a table out and says so.
  Other people's votes and poll answers in a file are not imported, and a file's poll belongs to you. Your own backup copy and your own copy and paste on the same board are unchanged.
- A large board file is written in several steps, and its comments in pieces of their own. Each step is confirmed by the server before the next, and the end for up to a minute; if part of it does not arrive you are told plainly and can remove what was imported.
  If the server cannot be reached, the import is kept on this device and you are told it will be sent when you are back online; it is not abandoned.
  Removing it keeps what you changed since (a renamed board keeps its new name, an edited note, comment or reply stays), gives back settings the board had before, and removes the imported comments.
  The whole import is one Undo step.
- Board files from other people are checked while they are read: a file larger than 100 MiB, one that inflates to more than 512 MiB, board data over 32 MiB or more than 50,000 objects is refused with a message, and a file built to expand is stopped long before it fills memory.
- A board file saved in the newer Yjs V2 format, or damaged (extra data at the end, an absurd list of deleted items), is refused with a message instead of opening empty.
  Removing an import works on plain http installs too, and compares the exact content, so anything you edited stays.
- The desktop app's own backup copies keep a separate, much larger limit (512 MiB file, 256 MiB of board data), so a big board is always restored after the app's storage was lost.
  When a backup cannot be restored or merged, the app now says so with a way to try again and to save a copy of the backup file; before, it only wrote to a log and the board opened empty.
- Preparing a big import no longer freezes the page: the work is done in slices of about 30 ms with the page shown "Importing... n of m". Removing an import ("Remove imported content") is still one quick step that can pause the page briefly on a very large board.
- Template files, saved and shared templates, and pasted or imported objects take the same cleaning: only the fields that belong to an object's type are kept (no authors, owners, locks, hidden marks or tracker links in a template), web addresses in link cards and cards must be http(s), and Markdown links and table cells keep only http(s), mailto and in-board links (a javascript:, data: or vbscript: link becomes plain text).
  Control characters that make an SVG or PNG export fail (and right-to-left override characters that make text read differently from how it is stored) are removed from text, names and table cells that come in this way.
