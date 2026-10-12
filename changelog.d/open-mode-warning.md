section: Security

- The README and accounts guide now say plainly that open mode (no accounts, no Origin check, unlimited rooms) is for localhost and trusted networks only, and point to accounts mode.
  The relay logs one warning at startup when open mode listens on a non-loopback address; nothing else changes.
