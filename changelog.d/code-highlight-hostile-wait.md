section: Fixed
audience: dev

- The hostile code block browser test no longer waits for a second worker only. On a loaded runner the worker's own tokenizer limit can answer before the 1.5 s watchdog, so no restart happens; the test now waits for either outcome (up to 15 s) and still asserts the block is drawn plain, the page stays responsive and no new worker is asked for the same text.
