import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";

import { VictoryCondition } from "@t3tools/contracts";
import { toPersistenceSqlError } from "../Errors.ts";
import {
  DeleteProjectionBattleInput,
  GetProjectionBattleInput,
  ProjectionBattle,
  ProjectionBattleRepository,
  type ProjectionBattleRepositoryShape,
} from "../Services/ProjectionBattles.ts";

const ProjectionBattleDbRow = ProjectionBattle.mapFields(
  Struct.assign({
    victoryConditions: Schema.fromJsonString(Schema.Array(VictoryCondition)),
  }),
);
type ProjectionBattleDbRow = typeof ProjectionBattleDbRow.Type;

const makeProjectionBattleRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertProjectionBattleRow = SqlSchema.void({
    Request: ProjectionBattle,
    execute: (row) =>
      sql`
        INSERT INTO projection_battles (
          battle_id,
          project_id,
          title,
          goal,
          slug,
          phase,
          victory_conditions_json,
          defeated_at,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          ${row.battleId},
          ${row.projectId},
          ${row.title},
          ${row.goal},
          ${row.slug},
          ${row.phase},
          ${JSON.stringify(row.victoryConditions)},
          ${row.defeatedAt},
          ${row.createdAt},
          ${row.updatedAt},
          ${row.deletedAt}
        )
        ON CONFLICT (battle_id)
        DO UPDATE SET
          project_id = excluded.project_id,
          title = excluded.title,
          goal = excluded.goal,
          slug = excluded.slug,
          phase = excluded.phase,
          victory_conditions_json = excluded.victory_conditions_json,
          defeated_at = excluded.defeated_at,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at,
          deleted_at = excluded.deleted_at
      `,
  });

  const getProjectionBattleRow = SqlSchema.findOneOption({
    Request: GetProjectionBattleInput,
    Result: ProjectionBattleDbRow,
    execute: ({ battleId }) =>
      sql`
        SELECT
          battle_id AS "battleId",
          project_id AS "projectId",
          title,
          goal,
          slug,
          phase,
          victory_conditions_json AS "victoryConditions",
          defeated_at AS "defeatedAt",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          deleted_at AS "deletedAt"
        FROM projection_battles
        WHERE battle_id = ${battleId}
      `,
  });

  const listProjectionBattleRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionBattleDbRow,
    execute: () =>
      sql`
        SELECT
          battle_id AS "battleId",
          project_id AS "projectId",
          title,
          goal,
          slug,
          phase,
          victory_conditions_json AS "victoryConditions",
          defeated_at AS "defeatedAt",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          deleted_at AS "deletedAt"
        FROM projection_battles
        ORDER BY created_at ASC, battle_id ASC
      `,
  });

  const deleteProjectionBattleRow = SqlSchema.void({
    Request: DeleteProjectionBattleInput,
    execute: ({ battleId }) =>
      sql`
        DELETE FROM projection_battles
        WHERE battle_id = ${battleId}
      `,
  });

  const upsert: ProjectionBattleRepositoryShape["upsert"] = (row) =>
    upsertProjectionBattleRow(row).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionBattleRepository.upsert:query")),
    );

  const getById: ProjectionBattleRepositoryShape["getById"] = (input) =>
    getProjectionBattleRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionBattleRepository.getById:query")),
    );

  const listAll: ProjectionBattleRepositoryShape["listAll"] = () =>
    listProjectionBattleRows().pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionBattleRepository.listAll:query")),
    );

  const deleteById: ProjectionBattleRepositoryShape["deleteById"] = (input) =>
    deleteProjectionBattleRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionBattleRepository.deleteById:query")),
    );

  return {
    upsert,
    getById,
    listAll,
    deleteById,
  } satisfies ProjectionBattleRepositoryShape;
});

export const ProjectionBattleRepositoryLive = Layer.effect(
  ProjectionBattleRepository,
  makeProjectionBattleRepository,
);
