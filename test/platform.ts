// Which platform's code paths a test takes. `npm run test:repeat -- <files> --platform win32` (scripts/test-repeat.mjs)
// sets TABULA_TEST_PLATFORM=win32 to run the Windows branches of the tests on any system.
//
// The forced mode only changes this flag. It simulates Windows process semantics only where a test opts in, for
// example by killing a child with SIGKILL (no handler runs, as with TerminateProcess) or by skipping the tests that
// need POSIX signals. Code under test still sees the real process.platform, so it is a check of the test's own Windows
// branch, not of the server on Windows: CI on Windows stays the proof for that.
export const isWindows = (process.env.TABULA_TEST_PLATFORM || process.platform) === 'win32';

// True when win32 is forced on a system that is not Windows.
export const simulatedWindows = isWindows && process.platform !== 'win32';
