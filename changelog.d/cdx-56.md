section: Changed
audience: dev

- Board startup hydrates object caches and derived indexes in one traversal. For the report's 2,000-object scenario, full object visits during Store construction drop from 6,000 to 2,000 (a 66.7% reduction); the focused test counts materializations and verifies index behavior without wall-clock thresholds.
