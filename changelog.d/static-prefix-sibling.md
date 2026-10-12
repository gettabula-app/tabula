section: Security

- The relay no longer serves files from a folder next to the app folder whose name starts with the same text (for example `dist-old` beside `dist`).
  A malformed percent escape in a page, guide or icon address now gets a 400 answer instead of an unhandled error.
