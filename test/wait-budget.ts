// How long a test waits for something to happen (a relay to start, a save to land, a restore to finish) is written for a developer
// machine. The Windows CI runners are about 20 times slower for real restores, backups and child-process relays, and every fixed wait
// of 5 to 15 s timed out there one by one. `budget(ms)` is the one place that scales them: unchanged on macOS and Linux (a real hang
// still fails fast), ten times longer on Windows, or set TABULA_TEST_TIME_FACTOR to override on any machine.

const fromEnv = Number(process.env.TABULA_TEST_TIME_FACTOR);
export const TIME_FACTOR = Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : process.platform === 'win32' ? 10 : 1;

/** A wait of `ms` milliseconds as written for a developer machine, scaled for the machine running the test. */
export const budget = (ms: number): number => ms * TIME_FACTOR;
