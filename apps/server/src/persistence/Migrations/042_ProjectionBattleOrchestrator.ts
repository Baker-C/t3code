import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const battleColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_battles)
  `;

  // Nullable with no backfill: the orchestrator reactor claims every battle
  // that still reads null on the next startup, so existing battles converge
  // without this migration having to mint threads.
  if (!battleColumns.some((column) => column.name === "orchestrator_thread_id")) {
    yield* sql`
      ALTER TABLE projection_battles
      ADD COLUMN orchestrator_thread_id TEXT
    `;
  }
});
