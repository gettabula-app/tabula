section: Added
audience: dev

- The class load test checks host load before running, refuses overloaded machines unless `LOAD_CLASS_ALLOW_BUSY=1` is set, and marks latency untrustworthy when the host is overloaded at the end.
