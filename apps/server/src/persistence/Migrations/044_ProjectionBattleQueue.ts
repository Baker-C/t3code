import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Priority is 0-3 with 0 meaning "unset", so the default is also the correct
  // backfill for every project and battle that predates the queue.
  const projectColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_projects)
  `;
  if (!projectColumns.some((column) => column.name === "priority")) {
    yield* sql`
      ALTER TABLE projection_projects
      ADD COLUMN priority INTEGER NOT NULL DEFAULT 0
    `;
  }

  const battleColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_battles)
  `;
  if (!battleColumns.some((column) => column.name === "priority")) {
    yield* sql`
      ALTER TABLE projection_battles
      ADD COLUMN priority INTEGER NOT NULL DEFAULT 0
    `;
  }
  // The partition is stored sparsely, so an empty list is the correct starting
  // state: every thread is already in a group of its own.
  if (!battleColumns.some((column) => column.name === "thread_groups_json")) {
    yield* sql`
      ALTER TABLE projection_battles
      ADD COLUMN thread_groups_json TEXT NOT NULL DEFAULT '[]'
    `;
  }

  // One row per queued battle: a battle appears in the queue exactly once, no
  // matter how many actions it has. Actions ride inline as JSON for the same
  // reason victory conditions do — the list is small and always read with its
  // entry.
  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_queue_entries (
      battle_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      order_key INTEGER NOT NULL,
      skipped_in_lap INTEGER NOT NULL DEFAULT 0,
      actions_json TEXT NOT NULL,
      added_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_queue_entries_project_id
    ON projection_queue_entries(project_id)
  `;
});
