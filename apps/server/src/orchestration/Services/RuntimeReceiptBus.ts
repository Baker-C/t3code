/**
 * RuntimeReceiptBus - Internal checkpoint-reactor synchronization receipts.
 *
 * This service exists to expose short-lived orchestration milestones that are
 * useful in tests and harnesses but are not part of the production runtime
 * event model. `CheckpointReactor` publishes receipts such as baseline capture,
 * diff finalization, and turn-processing quiescence so integration tests can
 * wait for those exact points without inferring them indirectly from persisted
 * state.
 *
 * Production code should only call `publish`. Test code may subscribe via
 * `streamEventsForTest`, which is intentionally named to make the intended
 * usage explicit.
 *
 * @module RuntimeReceiptBus
 */
import {
  BattleId,
  CheckpointRef,
  IsoDateTime,
  QueueActionId,
  QueueActionOutcome,
  NonNegativeInt,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";

export const CheckpointBaselineCapturedReceipt = Schema.Struct({
  type: Schema.Literal("checkpoint.baseline.captured"),
  threadId: ThreadId,
  checkpointTurnCount: NonNegativeInt,
  checkpointRef: CheckpointRef,
  createdAt: IsoDateTime,
});
export type CheckpointBaselineCapturedReceipt = typeof CheckpointBaselineCapturedReceipt.Type;

export const CheckpointDiffFinalizedReceipt = Schema.Struct({
  type: Schema.Literal("checkpoint.diff.finalized"),
  threadId: ThreadId,
  turnId: TurnId,
  checkpointTurnCount: NonNegativeInt,
  checkpointRef: CheckpointRef,
  status: Schema.Literals(["ready", "missing", "error"]),
  createdAt: IsoDateTime,
});
export type CheckpointDiffFinalizedReceipt = typeof CheckpointDiffFinalizedReceipt.Type;

export const TurnProcessingQuiescedReceipt = Schema.Struct({
  type: Schema.Literal("turn.processing.quiesced"),
  threadId: ThreadId,
  turnId: TurnId,
  checkpointTurnCount: NonNegativeInt,
  createdAt: IsoDateTime,
});
export type TurnProcessingQuiescedReceipt = typeof TurnProcessingQuiescedReceipt.Type;

/**
 * One pass of the retirement reactor over a defeated battle's worktrees.
 * Every candidate path lands in exactly one bucket, so a test can assert the
 * whole outcome from a single receipt.
 */
export const BattleWorktreeRetirementSettledReceipt = Schema.Struct({
  type: Schema.Literal("battle.worktree-retirement.settled"),
  battleId: BattleId,
  retired: Schema.Array(Schema.String),
  skippedShared: Schema.Array(Schema.String),
  skippedDirty: Schema.Array(Schema.String),
  skippedFailed: Schema.Array(Schema.String),
  createdAt: IsoDateTime,
});
export type BattleWorktreeRetirementSettledReceipt =
  typeof BattleWorktreeRetirementSettledReceipt.Type;

/**
 * One battle gained its orchestrator thread. `source` separates the reactor
 * reacting to a fresh `battle.created` from the startup pass that adopts a
 * battle predating orchestrators.
 */
export const BattleOrchestratorReadyReceipt = Schema.Struct({
  type: Schema.Literal("battle.orchestrator.ready"),
  battleId: BattleId,
  orchestratorThreadId: ThreadId,
  source: Schema.Literals(["created", "backfilled", "refreshed"]),
  createdAt: IsoDateTime,
});
export type BattleOrchestratorReadyReceipt = typeof BattleOrchestratorReadyReceipt.Type;

/** The startup backfill finished its single pass over existing battles. */
export const BattleOrchestratorBackfillSettledReceipt = Schema.Struct({
  type: Schema.Literal("battle.orchestrator.backfill-settled"),
  adopted: Schema.Array(BattleId),
  createdAt: IsoDateTime,
});
export type BattleOrchestratorBackfillSettledReceipt =
  typeof BattleOrchestratorBackfillSettledReceipt.Type;

/**
 * One examined member-turn settle. Every outcome is named so a test can wait
 * on the exact point a report-back guard fired instead of proving a negative
 * with a timeout.
 */
export const BattleOrchestratorReportSettledReceipt = Schema.Struct({
  type: Schema.Literal("battle.orchestrator.report-settled"),
  battleId: BattleId,
  // The member whose turn settled, or null when the orchestrator's own turn
  // ending is what triggered the flush.
  memberThreadId: Schema.NullOr(ThreadId),
  outcome: Schema.Literals(["delivered", "buffered", "ignored"]),
  // The members covered by a delivered report, oldest reply first.
  deliveredFor: Schema.Array(ThreadId),
  createdAt: IsoDateTime,
});
export type BattleOrchestratorReportSettledReceipt =
  typeof BattleOrchestratorReportSettledReceipt.Type;

/**
 * One examined queue signal. Every outcome is named so a test can wait on the
 * exact point the reactor decided, rather than proving a negative with a
 * timeout.
 *
 * "opened" and "widened" are the kick-off side: a turn starting in a queued
 * battle either opens an action for its thread group or joins the one already
 * covering it. "settled" is a wake rule firing, "waiting" is a rule that has
 * not fired yet, and "ignored" covers every signal that concerned no queued
 * battle.
 */
export const BattleQueueReadinessSettledReceipt = Schema.Struct({
  type: Schema.Literal("battle.queue.readiness-settled"),
  battleId: Schema.NullOr(BattleId),
  threadId: ThreadId,
  actionId: Schema.NullOr(QueueActionId),
  outcome: Schema.Literals(["opened", "widened", "settled", "waiting", "ignored"]),
  // Set only on "settled": how the action wants you.
  actionOutcome: Schema.NullOr(QueueActionOutcome),
  createdAt: IsoDateTime,
});
export type BattleQueueReadinessSettledReceipt = typeof BattleQueueReadinessSettledReceipt.Type;

export const OrchestrationRuntimeReceipt = Schema.Union([
  CheckpointBaselineCapturedReceipt,
  CheckpointDiffFinalizedReceipt,
  TurnProcessingQuiescedReceipt,
  BattleWorktreeRetirementSettledReceipt,
  BattleOrchestratorReadyReceipt,
  BattleOrchestratorBackfillSettledReceipt,
  BattleOrchestratorReportSettledReceipt,
  BattleQueueReadinessSettledReceipt,
]);
export type OrchestrationRuntimeReceipt = typeof OrchestrationRuntimeReceipt.Type;

export interface RuntimeReceiptBusShape {
  readonly publish: (receipt: OrchestrationRuntimeReceipt) => Effect.Effect<void>;
  readonly streamEventsForTest: Stream.Stream<OrchestrationRuntimeReceipt>;
}

export class RuntimeReceiptBus extends Context.Service<RuntimeReceiptBus, RuntimeReceiptBusShape>()(
  "t3/orchestration/Services/RuntimeReceiptBus",
) {}
