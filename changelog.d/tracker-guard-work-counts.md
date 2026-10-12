section: Fixed
audience: dev

- The tracker guard's timing tests (500 tickets in one update, an unlinked room, a 10,000-object room) now count SQL statements and object snapshots instead of reading the clock, so a loaded machine cannot fail them.
