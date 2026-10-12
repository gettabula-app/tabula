section: Added
audience: dev

- Add `workspace_hour` fleet reports with their own control-plane envelope, cloud-aligned closed enums, and optional capacity, backup-age, disk and version fields. The scrubber requires `source: 'control_plane'` and exactly one event, and strips instance collections from fleet reports.
