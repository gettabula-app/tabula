section: Added
audience: dev

- Add the guarded, pinned link-preview fetcher and metadata parser with DNS, redirect, size, timeout and text-cleaning tests.
- Keep title and head scanning linear on malformed and dense input, canonicalize IDNA deny-list names, and strip the full invisible/bidi control set.
- Stop head reads only at a real closing tag, cap response headers at 16 KiB, and classify header overflow plus stacked or unknown content encodings as `unreachable`.
