section: Changed
audience: dev

- The settle-backup relay tests wait for the status they assert (and print the last status on failure) and read room files again on Windows when the relay is replacing them.
