/**
 * ProjectionBattleRepository - Projection repository interface for battles.
 *
 * Owns persistence operations for battle rows in the orchestration projection
 * read model. Victory conditions ride inline as JSON: the list is small and
 * always read with its battle.
 *
 * @module ProjectionBattleRepository
 */
import {
  BattleId,
  BattlePhase,
  BattleThreadGroup,
  IsoDateTime,
  ProjectId,
  QueuePriority,
  ThreadId,
  VictoryCondition,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionBattle = Schema.Struct({
  battleId: BattleId,
  projectId: ProjectId,
  title: Schema.String,
  goal: Schema.NullOr(Schema.String),
  slug: Schema.String,
  phase: BattlePhase,
  victoryConditions: Schema.Array(VictoryCondition),
  orchestratorThreadId: Schema.NullOr(ThreadId),
  priority: QueuePriority,
  // Sparse: only the groups holding more than one thread are stored.
  threadGroups: Schema.Array(BattleThreadGroup),
  defeatedAt: Schema.NullOr(IsoDateTime),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  deletedAt: Schema.NullOr(IsoDateTime),
});
export type ProjectionBattle = typeof ProjectionBattle.Type;

export const GetProjectionBattleInput = Schema.Struct({
  battleId: BattleId,
});
export type GetProjectionBattleInput = typeof GetProjectionBattleInput.Type;

export const DeleteProjectionBattleInput = Schema.Struct({
  battleId: BattleId,
});
export type DeleteProjectionBattleInput = typeof DeleteProjectionBattleInput.Type;

/**
 * ProjectionBattleRepositoryShape - Service API for projected battle records.
 */
export interface ProjectionBattleRepositoryShape {
  /**
   * Insert or replace a projected battle row.
   *
   * Upserts by `battleId` and persists victory conditions through JSON encoding.
   */
  readonly upsert: (row: ProjectionBattle) => Effect.Effect<void, ProjectionRepositoryError>;

  /**
   * Read a projected battle row by id.
   */
  readonly getById: (
    input: GetProjectionBattleInput,
  ) => Effect.Effect<Option.Option<ProjectionBattle>, ProjectionRepositoryError>;

  /**
   * List all projected battle rows.
   *
   * Returned in deterministic creation order.
   */
  readonly listAll: () => Effect.Effect<ReadonlyArray<ProjectionBattle>, ProjectionRepositoryError>;

  /**
   * Hard-delete a projected battle row by id.
   */
  readonly deleteById: (
    input: DeleteProjectionBattleInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

/**
 * ProjectionBattleRepository - Service tag for battle projection persistence.
 */
export class ProjectionBattleRepository extends Context.Service<
  ProjectionBattleRepository,
  ProjectionBattleRepositoryShape
>()("t3/persistence/Services/ProjectionBattles/ProjectionBattleRepository") {}
