import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_battles (
      battle_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      goal TEXT,
      slug TEXT NOT NULL,
      phase TEXT NOT NULL,
      victory_conditions_json TEXT NOT NULL,
      defeated_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_battles_project_id
    ON projection_battles(project_id)
  `;

  const threadColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;

  if (!threadColumns.some((column) => column.name === "battle_id")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN battle_id TEXT
    `;
  }

  if (!threadColumns.some((column) => column.name === "turn_queued")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN turn_queued INTEGER NOT NULL DEFAULT 0
    `;
  }

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_threads_battle_id
    ON projection_threads(battle_id)
  `;
});
