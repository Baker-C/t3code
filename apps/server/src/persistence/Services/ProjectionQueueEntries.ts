/**
 * ProjectionQueueEntryRepository - Projection repository for the battle queue.
 *
 * Owns persistence for the environment's queue: one row per queued battle,
 * with its actions inline as JSON. Actions ride inline for the same reason
 * victory conditions do — the list is small and is always read with its entry.
 *
 * @module ProjectionQueueEntryRepository
 */
import { BattleId, IsoDateTime, NonNegativeInt, ProjectId, QueueAction } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionQueueEntry = Schema.Struct({
  battleId: BattleId,
  projectId: ProjectId,
  orderKey: NonNegativeInt,
  // Stored as an int like the other projection booleans.
  skippedInLap: NonNegativeInt,
  actions: Schema.Array(QueueAction),
  addedAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ProjectionQueueEntry = typeof ProjectionQueueEntry.Type;

export const GetProjectionQueueEntryInput = Schema.Struct({
  battleId: BattleId,
});
export type GetProjectionQueueEntryInput = typeof GetProjectionQueueEntryInput.Type;

export const DeleteProjectionQueueEntryInput = Schema.Struct({
  battleId: BattleId,
});
export type DeleteProjectionQueueEntryInput = typeof DeleteProjectionQueueEntryInput.Type;

export const ClearProjectionQueueSkipsInput = Schema.Struct({
  updatedAt: IsoDateTime,
});
export type ClearProjectionQueueSkipsInput = typeof ClearProjectionQueueSkipsInput.Type;

/**
 * ProjectionQueueEntryRepositoryShape - Service API for queue projection rows.
 */
export interface ProjectionQueueEntryRepositoryShape {
  /** Insert or replace one queued battle's row. */
  readonly upsert: (row: ProjectionQueueEntry) => Effect.Effect<void, ProjectionRepositoryError>;

  readonly getById: (
    input: GetProjectionQueueEntryInput,
  ) => Effect.Effect<Option.Option<ProjectionQueueEntry>, ProjectionRepositoryError>;

  /** Every queued battle, in queue order (tier position, then id). */
  readonly listAll: () => Effect.Effect<
    ReadonlyArray<ProjectionQueueEntry>,
    ProjectionRepositoryError
  >;

  readonly deleteById: (
    input: DeleteProjectionQueueEntryInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  /**
   * Ends the lap: clears every skip in one statement. A per-row loop would be
   * the same write done N times, and the lap is a single fact about the queue.
   */
  readonly clearSkips: (
    input: ClearProjectionQueueSkipsInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

/**
 * ProjectionQueueEntryRepository - Service tag for queue projection persistence.
 */
export class ProjectionQueueEntryRepository extends Context.Service<
  ProjectionQueueEntryRepository,
  ProjectionQueueEntryRepositoryShape
>()("t3/persistence/Services/ProjectionQueueEntries/ProjectionQueueEntryRepository") {}
