section: Fixed

- A room file the relay cannot decode (cut short, damaged on disk) is set aside as `<board>.yjs.corrupt-<time>` before the
  room opens empty, so the next save no longer writes an empty board over it; people who have the board offline bring it
  back by syncing. A file that cannot be read at that moment leaves the room closed (the socket gets 1011) instead.
- A room save that fails (a full disk, a permission problem) no longer ends the relay with an uncaught error, which lost
  the unsaved edits of every other room. The relay logs it and tries again after 5 seconds; the edits stay in memory, a
  room that could not be saved is not unloaded, and at shutdown the other rooms are still saved.
