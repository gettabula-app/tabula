section: Added
audience: user

- MCP OAuth discovery and public client registration are included in the first OAuth slice. Nothing changes until an operator sets `TABULA_MCP_OAUTH=on`; connector sign-in arrives in a later slice.
  Rollback to v4 is unsafe after migration 16 ships (`rollbackSafe=false` in the control-plane dry run); follow the rollback runbook.
