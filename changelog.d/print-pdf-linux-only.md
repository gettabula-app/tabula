section: Changed
audience: dev

- The PDF font-embedding test of the print dialog runs on Linux only (macOS Chromium embeds fonts differently); the browser-test check on the Linux CI leg now also fails when a browser test file skips a test it is not allowed to skip (only the asset store WebKit test may).
