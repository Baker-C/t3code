import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";

import { QueueAction } from "@t3tools/contracts";
import { toPersistenceSqlError } from "../Errors.ts";
import {
  ClearProjectionQueueSkipsInput,
  DeleteProjectionQueueEntryInput,
  GetProjectionQueueEntryInput,
  ProjectionQueueEntry,
  ProjectionQueueEntryRepository,
  type ProjectionQueueEntryRepositoryShape,
} from "../Services/ProjectionQueueEntries.ts";

const ProjectionQueueEntryDbRow = ProjectionQueueEntry.mapFields(
  Struct.assign({
    actions: Schema.fromJsonString(Schema.Array(QueueAction)),
  }),
);
type ProjectionQueueEntryDbRow = typeof ProjectionQueueEntryDbRow.Type;

const makeProjectionQueueEntryRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertProjectionQueueEntryRow = SqlSchema.void({
    Request: ProjectionQueueEntry,
    execute: (row) =>
      sql`
        INSERT INTO projection_queue_entries (
          battle_id,
          project_id,
          order_key,
          skipped_in_lap,
          actions_json,
          added_at,
          updated_at
        )
        VALUES (
          ${row.battleId},
          ${row.projectId},
          ${row.orderKey},
          ${row.skippedInLap},
          ${JSON.stringify(row.actions)},
          ${row.addedAt},
          ${row.updatedAt}
        )
        ON CONFLICT (battle_id)
        DO UPDATE SET
          project_id = excluded.project_id,
          order_key = excluded.order_key,
          skipped_in_lap = excluded.skipped_in_lap,
          actions_json = excluded.actions_json,
          added_at = excluded.added_at,
          updated_at = excluded.updated_at
      `,
  });

  const getProjectionQueueEntryRow = SqlSchema.findOneOption({
    Request: GetProjectionQueueEntryInput,
    Result: ProjectionQueueEntryDbRow,
    execute: ({ battleId }) =>
      sql`
        SELECT
          battle_id AS "battleId",
          project_id AS "projectId",
          order_key AS "orderKey",
          skipped_in_lap AS "skippedInLap",
          actions_json AS "actions",
          added_at AS "addedAt",
          updated_at AS "updatedAt"
        FROM projection_queue_entries
        WHERE battle_id = ${battleId}
      `,
  });

  const listProjectionQueueEntryRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionQueueEntryDbRow,
    execute: () =>
      sql`
        SELECT
          battle_id AS "battleId",
          project_id AS "projectId",
          order_key AS "orderKey",
          skipped_in_lap AS "skippedInLap",
          actions_json AS "actions",
          added_at AS "addedAt",
          updated_at AS "updatedAt"
        FROM projection_queue_entries
        ORDER BY order_key ASC, battle_id ASC
      `,
  });

  const deleteProjectionQueueEntryRow = SqlSchema.void({
    Request: DeleteProjectionQueueEntryInput,
    execute: ({ battleId }) =>
      sql`
        DELETE FROM projection_queue_entries
        WHERE battle_id = ${battleId}
      `,
  });

  const clearProjectionQueueSkipRows = SqlSchema.void({
    Request: ClearProjectionQueueSkipsInput,
    execute: ({ updatedAt }) =>
      sql`
        UPDATE projection_queue_entries
        SET skipped_in_lap = 0, updated_at = ${updatedAt}
        WHERE skipped_in_lap != 0
      `,
  });

  const upsert: ProjectionQueueEntryRepositoryShape["upsert"] = (row) =>
    upsertProjectionQueueEntryRow(row).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionQueueEntryRepository.upsert:query")),
    );

  const getById: ProjectionQueueEntryRepositoryShape["getById"] = (input) =>
    getProjectionQueueEntryRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionQueueEntryRepository.getById:query")),
    );

  const listAll: ProjectionQueueEntryRepositoryShape["listAll"] = () =>
    listProjectionQueueEntryRows().pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionQueueEntryRepository.listAll:query")),
    );

  const deleteById: ProjectionQueueEntryRepositoryShape["deleteById"] = (input) =>
    deleteProjectionQueueEntryRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionQueueEntryRepository.deleteById:query")),
    );

  const clearSkips: ProjectionQueueEntryRepositoryShape["clearSkips"] = (input) =>
    clearProjectionQueueSkipRows(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionQueueEntryRepository.clearSkips:query")),
    );

  return {
    upsert,
    getById,
    listAll,
    deleteById,
    clearSkips,
  } satisfies ProjectionQueueEntryRepositoryShape;
});

export const ProjectionQueueEntryRepositoryLive = Layer.effect(
  ProjectionQueueEntryRepository,
  makeProjectionQueueEntryRepository,
);
