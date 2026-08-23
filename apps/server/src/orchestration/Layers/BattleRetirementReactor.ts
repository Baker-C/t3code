import {
  CommandId,
  EventId,
  type BattleId,
  type OrchestrationEvent,
  type ThreadId,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { findWorktreeSiblingThreadIds } from "../../checkpointing/SharedWorktree.ts";
import { resolveLinkedWorktreeRepositoryRoot } from "../../git/Utils.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import { forkParked } from "../../serverActivation.ts";
import { VcsStatusBroadcaster } from "../../vcs/VcsStatusBroadcaster.ts";
import {
  BattleRetirementReactor,
  type BattleRetirementReactorShape,
} from "../Services/BattleRetirementReactor.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionWorktreeOccupancy,
} from "../Services/ProjectionSnapshotQuery.ts";
import { RuntimeReceiptBus } from "../Services/RuntimeReceiptBus.ts";

type BattlePhaseChangedEvent = Extract<OrchestrationEvent, { type: "battle.phase-changed" }>;

type WorktreeOccupant = ProjectionWorktreeOccupancy["threads"][number];

/** Why one worktree was left in place, or that it was removed. */
type RetirementOutcome = "retired" | "shared" | "dirty" | "failed";

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const randomUUID = crypto.randomUUIDv4;
  const serverCommandId = (tag: string) =>
    randomUUID.pipe(Effect.map((uuid) => CommandId.make(`server:${tag}:${uuid}`)));
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const gitVcsDriver = yield* GitVcsDriver.GitVcsDriver;
  const vcsStatusBroadcaster = yield* VcsStatusBroadcaster;
  const receiptBus = yield* RuntimeReceiptBus;

  const appendRetirementActivity = (input: {
    readonly threadId: ThreadId;
    readonly outcome: RetirementOutcome;
    readonly summary: string;
    readonly detail: string;
    readonly worktreePath: string;
    readonly createdAt: string;
  }) =>
    Effect.all({
      commandId: serverCommandId("battle-worktree-retirement"),
      activityId: randomUUID.pipe(Effect.map(EventId.make)),
    }).pipe(
      Effect.flatMap(({ commandId, activityId }) =>
        orchestrationEngine.dispatch({
          type: "thread.activity.append",
          commandId,
          threadId: input.threadId,
          activity: {
            id: activityId,
            tone: input.outcome === "retired" ? "info" : "error",
            kind: `battle.worktree.${input.outcome}`,
            summary: input.summary,
            payload: {
              worktreePath: input.worktreePath,
              detail: input.detail,
            },
            turnId: null,
            createdAt: input.createdAt,
          },
          createdAt: input.createdAt,
        }),
      ),
      Effect.catch(() => Effect.void),
    );

  // The branch is deliberately left alone: retirement reclaims disk, it does
  // not discard work. Clearing worktreePath is what lets a reopened battle
  // re-provision lazily from the branch that stayed behind.
  const releaseWorktreeFromThreads = (input: {
    readonly threads: ReadonlyArray<WorktreeOccupant>;
    readonly createdAt: string;
  }) =>
    Effect.forEach(
      input.threads,
      (thread) =>
        serverCommandId("battle-worktree-release").pipe(
          Effect.flatMap((commandId) =>
            orchestrationEngine.dispatch({
              type: "thread.meta.update",
              commandId,
              threadId: thread.id,
              worktreePath: null,
            }),
          ),
          // The directory is already gone; a failed update only leaves a stale
          // path on the thread, which must not abort the remaining releases.
          Effect.catch((error) =>
            Effect.logWarning("battle retirement could not clear thread worktree path", {
              threadId: thread.id,
              detail: error.message,
            }),
          ),
        ),
      { discard: true },
    );

  const retireWorktree = Effect.fn("retireWorktree")(function* (input: {
    readonly battleId: BattleId;
    readonly worktreePath: string;
    readonly occupants: ReadonlyArray<WorktreeOccupant>;
    readonly outsiderThreadIds: ReadonlyArray<ThreadId>;
    readonly createdAt: string;
  }): Effect.fn.Return<RetirementOutcome> {
    const notifyOccupants = (outcome: RetirementOutcome, summary: string, detail: string) =>
      Effect.forEach(
        input.occupants,
        (thread) =>
          appendRetirementActivity({
            threadId: thread.id,
            outcome,
            summary,
            detail,
            worktreePath: input.worktreePath,
            createdAt: input.createdAt,
          }),
        { discard: true },
      );

    if (input.outsiderThreadIds.length > 0) {
      yield* notifyOccupants(
        "shared",
        "Worktree kept: shared with other threads",
        `${input.worktreePath} is also used by ${input.outsiderThreadIds.length} thread(s) outside this battle, so it was left in place.`,
      );
      return "shared";
    }

    // A main working tree has no owning repository above it, and handing one
    // to `git worktree remove` would target the user's project root.
    const repositoryRoot = resolveLinkedWorktreeRepositoryRoot(input.worktreePath);
    if (!repositoryRoot) {
      yield* notifyOccupants(
        "failed",
        "Worktree kept: not a linked worktree",
        `${input.worktreePath} is not a linked git worktree, so it was left in place.`,
      );
      return "failed";
    }

    const local = yield* vcsStatusBroadcaster.refreshLocalStatus(input.worktreePath).pipe(
      Effect.catch((error) =>
        Effect.logWarning("battle retirement could not read worktree status", {
          battleId: input.battleId,
          worktreePath: input.worktreePath,
          detail: error.message,
        }).pipe(Effect.as(null)),
      ),
    );
    if (local === null) {
      yield* notifyOccupants(
        "failed",
        "Worktree kept: status unavailable",
        `Could not read the git status of ${input.worktreePath}, so it was left in place.`,
      );
      return "failed";
    }
    if (local.hasWorkingTreeChanges) {
      yield* notifyOccupants(
        "dirty",
        "Worktree kept: uncommitted changes",
        `${input.worktreePath} has uncommitted changes, so it was left in place. Commit or discard them, then retire it from the worktree menu.`,
      );
      return "dirty";
    }

    const removed = yield* gitVcsDriver
      .removeWorktree({ cwd: repositoryRoot, path: input.worktreePath })
      .pipe(
        Effect.as(true),
        Effect.catch((error) =>
          Effect.logWarning("battle retirement failed to remove worktree", {
            battleId: input.battleId,
            worktreePath: input.worktreePath,
            detail: error.message,
          }).pipe(Effect.as(false)),
        ),
      );
    if (!removed) {
      yield* notifyOccupants(
        "failed",
        "Worktree kept: removal failed",
        `git worktree remove failed for ${input.worktreePath}, so it was left in place.`,
      );
      return "failed";
    }

    yield* releaseWorktreeFromThreads({
      threads: input.occupants,
      createdAt: input.createdAt,
    });
    yield* notifyOccupants(
      "retired",
      "Worktree retired",
      `${input.worktreePath} was removed. The branch was kept, so reopening this battle can restore the worktree from it.`,
    );
    return "retired";
  });

  const publishSettled = (input: {
    readonly battleId: BattleId;
    readonly outcomes: Record<RetirementOutcome, ReadonlyArray<string>>;
  }) =>
    DateTime.now.pipe(
      Effect.flatMap((now) =>
        receiptBus.publish({
          type: "battle.worktree-retirement.settled",
          battleId: input.battleId,
          retired: input.outcomes.retired,
          skippedShared: input.outcomes.shared,
          skippedDirty: input.outcomes.dirty,
          skippedFailed: input.outcomes.failed,
          createdAt: DateTime.formatIso(now),
        }),
      ),
    );

  const processBattleDefeated = Effect.fn("processBattleDefeated")(function* (
    event: BattlePhaseChangedEvent,
  ) {
    const { battleId, phase, retireWorktrees } = event.payload;
    // Only defeat can retire anything; declaring fighting or reopening never
    // touches the filesystem.
    if (phase !== "defeated") {
      return;
    }

    const outcomes: Record<RetirementOutcome, Array<string>> = {
      retired: [],
      shared: [],
      dirty: [],
      failed: [],
    };

    // Retirement is the user's explicit choice, evented on the defeat command.
    // A defeat that declined it still settles - with nothing in any bucket - so
    // every defeat produces exactly one receipt.
    if (retireWorktrees !== true) {
      yield* publishSettled({ battleId, outcomes });
      return;
    }

    const { threads, projects } = yield* projectionSnapshotQuery.getWorktreeOccupancy();
    const members = threads.filter((thread) => thread.battleId === battleId);

    // Only real worktree paths are candidates. A member with no worktreePath
    // resolves to its project root, which is never ours to remove.
    const candidatePaths = [
      ...new Set(members.flatMap((member) => (member.worktreePath ? [member.worktreePath] : []))),
    ];

    for (const worktreePath of candidatePaths) {
      const occupants = members.filter((member) => member.worktreePath === worktreePath);
      const anchor = occupants[0];
      if (!anchor) {
        continue;
      }

      // Exclusive tenancy, computed over active *and* archived threads:
      // archiving a thread does not release its worktree, and the client-side
      // guard that misses this is exactly what this reactor replaces.
      const siblingThreadIds = findWorktreeSiblingThreadIds({
        threadId: anchor.id,
        threads,
        projects,
      });
      const outsiderThreadIds = siblingThreadIds.filter(
        (siblingId) => threads.find((thread) => thread.id === siblingId)?.battleId !== battleId,
      );

      const outcome = yield* retireWorktree({
        battleId,
        worktreePath,
        occupants,
        outsiderThreadIds,
        createdAt: event.occurredAt,
      });
      outcomes[outcome].push(worktreePath);
    }

    yield* publishSettled({ battleId, outcomes });
  });

  const processBattleDefeatedSafely = (event: BattlePhaseChangedEvent) =>
    processBattleDefeated(event).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("battle retirement reactor failed to process event", {
          eventType: event.type,
          battleId: event.payload.battleId,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(processBattleDefeatedSafely);

  const start: BattleRetirementReactorShape["start"] = Effect.fn("start")(function* () {
    yield* forkParked(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
        if (event.type !== "battle.phase-changed") {
          return Effect.void;
        }
        return worker.enqueue(event);
      }),
    );
  });

  return {
    start,
    drain: worker.drain,
  } satisfies BattleRetirementReactorShape;
});

export const BattleRetirementReactorLive = Layer.effect(BattleRetirementReactor, make);
