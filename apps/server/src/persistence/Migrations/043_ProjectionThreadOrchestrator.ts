import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const threadColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;

  if (!threadColumns.some((column) => column.name === "is_orchestrator")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN is_orchestrator INTEGER NOT NULL DEFAULT 0
    `;
    // Backfill from the battles that already name a manager, so orchestrators
    // minted before this column keep their flag and stay out of the member
    // lists. A refresh is what makes the flag outlive the binding.
    yield* sql`
      UPDATE projection_threads
      SET is_orchestrator = 1
      WHERE thread_id IN (
        SELECT orchestrator_thread_id
        FROM projection_battles
        WHERE orchestrator_thread_id IS NOT NULL
      )
    `;
  }
});
