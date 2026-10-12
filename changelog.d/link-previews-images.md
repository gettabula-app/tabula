section: Added
audience: dev

- Link previews, server side: the preview image and the site icon are fetched through the address guard on every hop and stored as assets of the asking board (another board claims them from the cache), `refresh` skips the cache, and join-code guests are refused with `guests_cannot_preview`.
