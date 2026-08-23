import { NonNegativeInt, ThreadId, type VcsError } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import type { ProjectionRepositoryError } from "../persistence/Errors.ts";

export const CheckpointDiffOperation = Schema.Literals([
  "CheckpointDiffQuery.getTurnDiff",
  "CheckpointDiffQuery.getFullThreadDiff",
]);
export type CheckpointDiffOperation = typeof CheckpointDiffOperation.Type;

/** The computed result does not satisfy the checkpoint RPC contract. */
export class CheckpointDiffResultInvalidError extends Schema.TaggedErrorClass<CheckpointDiffResultInvalidError>()(
  "CheckpointDiffResultInvalidError",
  {
    operation: CheckpointDiffOperation,
    threadId: ThreadId,
  },
) {
  override get message(): string {
    const result =
      this.operation === "CheckpointDiffQuery.getTurnDiff" ? "turn diff" : "full thread diff";
    return `Checkpoint invariant violation in ${this.operation}: Computed ${result} result does not satisfy contract schema.`;
  }
}

/** Projection state no longer contains the requested checkpoint thread. */
export class CheckpointThreadNotFoundError extends Schema.TaggedErrorClass<CheckpointThreadNotFoundError>()(
  "CheckpointThreadNotFoundError",
  {
    operation: CheckpointDiffOperation,
    threadId: ThreadId,
  },
) {
  override get message(): string {
    return `Checkpoint invariant violation in ${this.operation}: Thread '${this.threadId}' not found.`;
  }
}

/** The checkpoint thread has no workspace path from which to compute a diff. */
export class CheckpointWorkspacePathMissingError extends Schema.TaggedErrorClass<CheckpointWorkspacePathMissingError>()(
  "CheckpointWorkspacePathMissingError",
  {
    operation: CheckpointDiffOperation,
    threadId: ThreadId,
  },
) {
  override get message(): string {
    const diff =
      this.operation === "CheckpointDiffQuery.getTurnDiff" ? "turn diff" : "full thread diff";
    return `Checkpoint invariant violation in ${this.operation}: Workspace path missing for thread '${this.threadId}' when computing ${diff}.`;
  }
}

/** The requested turn lies beyond the latest available checkpoint. */
export class CheckpointTurnRangeUnavailableError extends Schema.TaggedErrorClass<CheckpointTurnRangeUnavailableError>()(
  "CheckpointTurnRangeUnavailableError",
  {
    operation: CheckpointDiffOperation,
    threadId: ThreadId,
    requestedTurnCount: NonNegativeInt,
    availableTurnCount: NonNegativeInt,
  },
) {
  override get message(): string {
    return `Checkpoint unavailable for thread ${this.threadId} turn ${this.requestedTurnCount}: Turn diff range exceeds current turn count: requested ${this.requestedTurnCount}, current ${this.availableTurnCount}.`;
  }
}

/** Expected checkpoint metadata does not contain the requested Git ref. */
export class CheckpointRefUnavailableError extends Schema.TaggedErrorClass<CheckpointRefUnavailableError>()(
  "CheckpointRefUnavailableError",
  {
    operation: CheckpointDiffOperation,
    threadId: ThreadId,
    turnCount: NonNegativeInt,
    checkpoint: Schema.Literals(["from", "to"]),
  },
) {
  override get message(): string {
    return `Checkpoint unavailable for thread ${this.threadId} turn ${this.turnCount}: Checkpoint ref is unavailable for turn ${this.turnCount}.`;
  }
}

/**
 * A baseline-relative diff was requested for a thread that shares its
 * worktree. Turn 0 of a shared directory is not this thread's starting point,
 * so the diff would report a sibling thread's work as this thread's.
 */
export class CheckpointSharedWorktreeDiffUnavailableError extends Schema.TaggedErrorClass<CheckpointSharedWorktreeDiffUnavailableError>()(
  "CheckpointSharedWorktreeDiffUnavailableError",
  {
    operation: CheckpointDiffOperation,
    threadId: ThreadId,
    workspacePath: Schema.String,
    siblingThreadCount: NonNegativeInt,
  },
) {
  override get message(): string {
    const others =
      this.siblingThreadCount === 1 ? "another thread" : `${this.siblingThreadCount} other threads`;
    return `All-turns diff is unavailable for thread '${this.threadId}': ${others} work in '${this.workspacePath}', so a diff from the first checkpoint would include their changes. View the per-turn diffs instead.`;
  }
}

/**
 * A revert would roll the shared worktree back past work a cwd-sibling did
 * after the target checkpoint. Restore is destructive and unscoped, so the
 * sibling's changes cannot be preserved - the revert is refused instead.
 */
export class CheckpointRevertBlockedBySharedWorktreeError extends Schema.TaggedErrorClass<CheckpointRevertBlockedBySharedWorktreeError>()(
  "CheckpointRevertBlockedBySharedWorktreeError",
  {
    threadId: ThreadId,
    turnCount: NonNegativeInt,
    blockingThreadId: ThreadId,
    blockingThreadTitle: Schema.String,
    blockingCheckpointAt: Schema.String,
  },
) {
  override get message(): string {
    return `Cannot revert to turn ${this.turnCount}: '${this.blockingThreadTitle}' shares this worktree and finished a turn at ${this.blockingCheckpointAt}, after the checkpoint you picked. Reverting would discard that thread's work.`;
  }
}

export type CheckpointStoreError = VcsError;

export type CheckpointServiceError =
  | CheckpointStoreError
  | ProjectionRepositoryError
  | CheckpointDiffResultInvalidError
  | CheckpointThreadNotFoundError
  | CheckpointWorkspacePathMissingError
  | CheckpointTurnRangeUnavailableError
  | CheckpointRefUnavailableError
  | CheckpointSharedWorktreeDiffUnavailableError;
