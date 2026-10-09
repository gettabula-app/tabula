// How long a test waits for a relay it started to say that it is listening. A Windows CI job runs two test files at a
// time on a shared runner and takes minutes; a relay that printed nothing for 15 seconds has been seen there (TAB-180).
// Every helper that starts a relay uses this one number. vite.config.ts keeps testTimeout and hookTimeout above it, so
// a slow start ends in the helper's own error, with the relay's output, and not in a bare timeout of the test.
export const RELAY_START_MS = 30_000;
