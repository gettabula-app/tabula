section: Changed

- The CI timing budget measures a test that is over its limit once more, alone, before failing the job. A test within its
  limit the second time is logged as a stalled sample with both times, so one stalled Windows runner no longer turns main red.
