section: Changed

- The hosted-workspace relay test starts its relays through a shared helper that reports a relay dying on start at once with
  its own output, and retries a taken port on a fresh one, instead of waiting 30 s for "relay did not start".
