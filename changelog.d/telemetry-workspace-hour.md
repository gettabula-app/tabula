section: Added
audience: dev

- Add the control-plane `workspace_hour` telemetry event for hourly workspace state, capacity, backup health and disk usage. The shared scrubber accepts control-plane events only with `source: 'control_plane'`, keeps the default instance gate, and limits each report to one `workspace_hour` event.
