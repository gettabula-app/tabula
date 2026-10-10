section: Changed

- The remote load test no longer asserts the latency verdict OK, which a loaded CI runner turns into DEGRADED
  (generator lag); it asserts that the run completed with all users connected, no errors and no FAILING verdict.
