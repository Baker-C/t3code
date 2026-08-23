/**
 * SharedWorktree - decides whether a thread's resolved working directory is
 * occupied by more than one thread.
 *
 * Checkpoint policy hangs off this answer. A thread that owns its worktree can
 * treat `turn/<n-1>` as the state it started turn `n` from; a thread that
 * shares one cannot, because a sibling's completed turns land in the same
 * directory between this thread's own checkpoints. Shared cwds therefore get
 * pre-turn refs, pre->post turn diffs, no baseline-relative diff, and a revert
 * guard. Archived threads count as occupants - archiving does not release the
 * path - while deleted threads never appear in either snapshot.
 *
 * @module SharedWorktree
 */
import type { ProjectId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { normalizeTurnGateKey } from "../provider/TurnGate.ts";
import { resolveThreadWorkspaceCwd } from "./Utils.ts";

export interface SharedWorktreeThread {
  readonly id: ThreadId;
  readonly projectId: ProjectId;
  readonly worktreePath: string | null;
}

export interface SharedWorktreeProject {
  readonly id: ProjectId;
  readonly workspaceRoot: string;
}

export interface SharedWorktreeInput {
  readonly threadId: ThreadId;
  readonly threads: ReadonlyArray<SharedWorktreeThread>;
  readonly projects: ReadonlyArray<SharedWorktreeProject>;
}

/**
 * The ids of the other threads whose resolved cwd is the same directory as
 * `threadId`'s. Empty when the thread is unknown, has no resolvable cwd, or
 * owns its directory outright.
 */
export function findWorktreeSiblingThreadIds(input: SharedWorktreeInput): ReadonlyArray<ThreadId> {
  const thread = input.threads.find((entry) => entry.id === input.threadId);
  if (!thread) {
    return [];
  }

  const cwd = resolveThreadWorkspaceCwd({ thread, projects: input.projects });
  if (!cwd) {
    return [];
  }
  const key = normalizeTurnGateKey(cwd);

  const siblings: Array<ThreadId> = [];
  for (const other of input.threads) {
    if (other.id === input.threadId) {
      continue;
    }
    const otherCwd = resolveThreadWorkspaceCwd({ thread: other, projects: input.projects });
    if (otherCwd !== undefined && normalizeTurnGateKey(otherCwd) === key) {
      siblings.push(other.id);
    }
  }
  return siblings;
}

export function worktreeIsShared(input: SharedWorktreeInput): boolean {
  return findWorktreeSiblingThreadIds(input).length > 0;
}

/**
 * Answers {@link findWorktreeSiblingThreadIds} for the live projection. Takes
 * the query service as an argument because every caller is a service closure
 * with an empty requirement channel.
 */
export const resolveWorktreeSiblingThreadIds = (
  projectionSnapshotQuery: ProjectionSnapshotQueryShape,
  threadId: ThreadId,
) =>
  projectionSnapshotQuery.getWorktreeOccupancy().pipe(
    Effect.map((occupancy) =>
      findWorktreeSiblingThreadIds({
        threadId,
        threads: occupancy.threads,
        projects: occupancy.projects,
      }),
    ),
    Effect.withSpan("resolveWorktreeSiblingThreadIds"),
  );

export const resolveWorktreeIsShared = (
  projectionSnapshotQuery: ProjectionSnapshotQueryShape,
  threadId: ThreadId,
) =>
  resolveWorktreeSiblingThreadIds(projectionSnapshotQuery, threadId).pipe(
    Effect.map((siblings) => siblings.length > 0),
  );
