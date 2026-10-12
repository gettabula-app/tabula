section: Fixed
audience: dev

- The relay answers a missing file (such as a new hashed chunk during a rolling deploy) with a 404 instead of index.html marked immutable.
  Only existing files under /assets/ get the immutable header.
- The service worker stores only successful responses of the expected type: no HTML under a script URL, no error page as the app shell, no opaque responses.
  Its cache version now changes with every build.
