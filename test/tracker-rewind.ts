// Tests that rewind a directory to an older schema (PRAGMA user_version = n) must also remove what migration 12 added,
// or replaying the later migrations meets tables and a column that already exist.
export const REMOVE_TRACKER_MIGRATION = `
  DROP TABLE IF EXISTS ticket_search; DROP TABLE IF EXISTS ticket_subscriptions; DROP TABLE IF EXISTS ticket_aliases;
  DROP TABLE IF EXISTS ticket_events; DROP TABLE IF EXISTS ticket_comments; DROP TABLE IF EXISTS ticket_labels;
  DROP TABLE IF EXISTS ticket_field_versions; DROP TABLE IF EXISTS tickets; DROP TABLE IF EXISTS labels;
  DROP TABLE IF EXISTS ticket_counters; DROP TABLE IF EXISTS ticket_states; DROP TABLE IF EXISTS ticket_workflows;
  DROP TABLE IF EXISTS trackers; ALTER TABLE access_tokens DROP COLUMN tracker;
`;
