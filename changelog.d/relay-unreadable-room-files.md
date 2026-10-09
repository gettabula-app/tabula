section: Fixed

- A room file the relay cannot read or decode (cut short, damaged on disk) leaves the room closed (the socket gets 1011)
  and the original file untouched until it is recovered. It can no longer become an empty board that overwrites the
  saved state and allows its images to be deleted. Failed opens also release their temporary documents.
- Image cleanup keeps a board's images when its saved file cannot be read, instead of treating read errors as an absent
  board. Version-history actions also report these read failures rather than treating the board as empty.
- A room save that fails (a full disk, a permission problem) no longer ends the relay with an uncaught error, which lost
  the unsaved edits of every other room. The relay logs it and tries again after 5 seconds; the edits stay in memory, a
  room that could not be saved is not unloaded, and at shutdown the other rooms are still saved. A failed final save
  exits with an error status; shutdown still ends the process, so edits that could not be saved cannot survive it.
- A workspace restore stops before maintenance if its final room saves fail. Connected clients and unsaved edits stay
  available while saving retries, rather than reporting success and losing edits made after the safety backup.
