section: Fixed
audience: dev

- A room save checks that its temporary file is still a regular file before it replaces the room file, so a directory that took the temporary name can never become the room file.
