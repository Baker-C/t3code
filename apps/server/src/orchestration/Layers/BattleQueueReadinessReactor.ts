import {
  battleThreadGroupFor,
  CommandId,
  DEFAULT_QUEUE_WAKE_RULE,
  queueWakeRuleSatisfied,
  QueueActionId,
  type BattleId,
  type OrchestrationEvent,
  type OrchestrationSessionStatus,
  type OrchestrationThreadShell,
  type QueueAction,
  type QueueActionOutcome,
  type ThreadId,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { forkParked } from "../../serverActivation.ts";
import {
  BattleQueueReadinessReactor,
  type BattleQueueReadinessReactorShape,
} from "../Services/BattleQueueReadinessReactor.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { RuntimeReceiptBus } from "../Services/RuntimeReceiptBus.ts";

type ThreadTurnStartRequestedEvent = Extract<
  OrchestrationEvent,
  { type: "thread.turn-start-requested" }
>;
type ThreadSessionSetEvent = Extract<OrchestrationEvent, { type: "thread.session-set" }>;

/**
 * Both halves run through one worker, so a kick-off and the settle that
 * follows it can never interleave. That serialization is what lets
 * `openAction` read the queue, decide, and write without a lock.
 */
type ReactorInput =
  | { readonly kind: "turn-started"; readonly event: ThreadTurnStartRequestedEvent }
  | { readonly kind: "turn-settled"; readonly event: ThreadSessionSetEvent };

/**
 * Mirrors `settledTurnStateForSessionStatus` in `ProjectionPipeline`: turn
 * settling is projection-internal and emits no event, so a session leaving
 * "starting"/"running" is the only turn-end signal on the wire.
 */
const isSettledSessionStatus = (status: OrchestrationSessionStatus): boolean =>
  status !== "starting" && status !== "running";

/**
 * Whether a thread is idle and awaiting the user — the unit the wake rules are
 * written in.
 *
 * A thread waiting on the TurnGate for a shared worktree counts as busy. From
 * the queue's point of view that is just a flavour of busy: a thread is either
 * working or wanting you, and there is nothing useful to show for
 * queued-behind-a-worktree.
 */
const threadIsIdle = (thread: OrchestrationThreadShell): boolean => {
  if (thread.turnQueued === true) return false;
  const status = thread.session?.status ?? null;
  return status === null || isSettledSessionStatus(status);
};

/**
 * How a settled action wants you.
 *
 * `errored` wins because it is the outcome you must not miss — it is the one
 * that gets a mark on the row, and it closes the gap where a failed turn goes
 * quiet and silently falls off your radar. A thread that finished cleanly and
 * will not be used again simply reads as `completed`; there is no separate
 * "resolved" state.
 */
const resolveActionOutcome = (
  threads: ReadonlyArray<OrchestrationThreadShell>,
): QueueActionOutcome => {
  let needsClarification = false;
  for (const thread of threads) {
    if (thread.session?.status === "error" || thread.latestTurn?.state === "error") {
      return "errored";
    }
    if (thread.hasPendingApprovals || thread.hasPendingUserInput) {
      needsClarification = true;
    }
  }
  return needsClarification ? "needs-clarification" : "completed";
};

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const randomUUID = crypto.randomUUIDv4;
  const serverCommandId = (tag: string) =>
    randomUUID.pipe(Effect.map((uuid) => CommandId.make(`server:${tag}:${uuid}`)));
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const receiptBus = yield* RuntimeReceiptBus;

  const publishReadiness = (input: {
    readonly battleId: BattleId | null;
    readonly threadId: ThreadId;
    readonly actionId: QueueActionId | null;
    readonly outcome: "opened" | "widened" | "settled" | "waiting" | "ignored";
    readonly actionOutcome?: QueueActionOutcome;
  }) =>
    DateTime.now.pipe(
      Effect.flatMap((now) =>
        receiptBus.publish({
          type: "battle.queue.readiness-settled",
          battleId: input.battleId,
          threadId: input.threadId,
          actionId: input.actionId,
          outcome: input.outcome,
          actionOutcome: input.actionOutcome ?? null,
          createdAt: DateTime.formatIso(now),
        }),
      ),
    );

  /**
   * Resolves a thread to the queued battle it belongs to, or none. Every
   * signal starts here, and most stop here: the overwhelming majority of turns
   * happen in battles nobody queued.
   */
  const resolveQueuedContext = Effect.fn("resolveQueuedContext")(function* (threadId: ThreadId) {
    const thread = yield* projectionSnapshotQuery.getThreadShellById(threadId);
    if (Option.isNone(thread)) return null;
    const battleId = thread.value.battleId ?? null;
    if (battleId === null) return null;
    const entry = yield* projectionSnapshotQuery.getQueueEntryByBattleId(battleId);
    if (Option.isNone(entry)) return null;
    const battle = yield* projectionSnapshotQuery.getBattleById(battleId);
    if (Option.isNone(battle)) return null;
    return { battleId, thread: thread.value, entry: entry.value, battle: battle.value };
  });

  /**
   * Opens the action a starting turn belongs to, or widens the open one that
   * already covers its group.
   *
   * The action forms around the thread's authored group rather than the single
   * thread, because the group is the unit you hand off as one piece. A second
   * thread of the same group starting joins that action instead of opening a
   * rival one, which is what keeps one hand-off to one row.
   */
  const openAction = Effect.fn("openAction")(function* (threadId: ThreadId) {
    const context = yield* resolveQueuedContext(threadId);
    if (context === null) {
      yield* publishReadiness({ battleId: null, threadId, actionId: null, outcome: "ignored" });
      return;
    }
    const group = battleThreadGroupFor({
      threadGroups: context.battle.threadGroups ?? [],
      threadId,
    });
    const open = context.entry.actions.find(
      (action) =>
        action.outcome === null && action.threadIds.some((member) => group.includes(member)),
    );
    if (open !== undefined && open.threadIds.includes(threadId)) {
      // Already covered. A retried turn in the same action is not news.
      yield* publishReadiness({
        battleId: context.battleId,
        threadId,
        actionId: open.id,
        outcome: "widened",
      });
      return;
    }
    const actionId = open?.id ?? QueueActionId.make(yield* randomUUID);
    const createdAt = DateTime.formatIso(yield* DateTime.now);
    yield* orchestrationEngine.dispatch({
      type: "battle.queue.action.start",
      commandId: yield* serverCommandId("queue-action-start"),
      battleId: context.battleId,
      actionId,
      threadIds: [threadId],
      // The rule the base availability statement describes. The UI and the
      // orchestrator's MCP tool relax it afterwards; neither has to be
      // consulted to get a correct default.
      wakeRule: DEFAULT_QUEUE_WAKE_RULE,
      createdAt,
    });
    yield* publishReadiness({
      battleId: context.battleId,
      threadId,
      actionId,
      outcome: open === undefined ? "opened" : "widened",
    });
  });

  /** Whether one open action's wake rule is now satisfied. */
  const evaluateAction = Effect.fn("evaluateAction")(function* (action: QueueAction) {
    const threads: OrchestrationThreadShell[] = [];
    for (const memberId of action.threadIds) {
      const member = yield* projectionSnapshotQuery.getThreadShellById(memberId);
      // A thread that has left (deleted, or never projected) cannot hold its
      // action open, or a battle would be stuck ready-never after a cleanup.
      if (Option.isSome(member)) threads.push(member.value);
    }
    const idleById = new Map(threads.map((thread) => [thread.id, threadIsIdle(thread)] as const));
    const satisfied = queueWakeRuleSatisfied({
      wakeRule: action.wakeRule,
      threadIds: action.threadIds,
      isIdle: (threadId) => idleById.get(threadId) ?? true,
    });
    return satisfied ? resolveActionOutcome(threads) : null;
  });

  const settleActions = Effect.fn("settleActions")(function* (threadId: ThreadId) {
    const context = yield* resolveQueuedContext(threadId);
    if (context === null) {
      yield* publishReadiness({ battleId: null, threadId, actionId: null, outcome: "ignored" });
      return;
    }
    const open = context.entry.actions.filter(
      (action) => action.outcome === null && action.threadIds.includes(threadId),
    );
    if (open.length === 0) {
      yield* publishReadiness({
        battleId: context.battleId,
        threadId,
        actionId: null,
        outcome: "ignored",
      });
      return;
    }
    for (const action of open) {
      const outcome = yield* evaluateAction(action);
      if (outcome === null) {
        // Still in flight. A group waiting on serialized threads simply waits
        // longer; that is expected, not an error condition.
        yield* publishReadiness({
          battleId: context.battleId,
          threadId,
          actionId: action.id,
          outcome: "waiting",
        });
        continue;
      }
      yield* orchestrationEngine.dispatch({
        type: "battle.queue.action.settle",
        commandId: yield* serverCommandId("queue-action-settle"),
        battleId: context.battleId,
        actionId: action.id,
        outcome,
      });
      yield* publishReadiness({
        battleId: context.battleId,
        threadId,
        actionId: action.id,
        outcome: "settled",
        actionOutcome: outcome,
      });
    }
  });

  const processInput = Effect.fn("processInput")(function* (input: ReactorInput) {
    if (input.kind === "turn-started") {
      yield* openAction(input.event.payload.threadId);
      return;
    }
    yield* settleActions(input.event.payload.threadId);
  });

  const processInputSafely = (input: ReactorInput) =>
    processInput(input).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.interrupt;
        }
        return Effect.logWarning("battle queue readiness reactor failed to process input", {
          kind: input.kind,
          threadId: input.event.payload.threadId,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(processInputSafely);

  const start: BattleQueueReadinessReactorShape["start"] = Effect.fn("start")(function* () {
    yield* forkParked(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
        if (event.type === "thread.turn-start-requested") {
          return worker.enqueue({ kind: "turn-started", event });
        }
        if (
          event.type === "thread.session-set" &&
          isSettledSessionStatus(event.payload.session.status)
        ) {
          return worker.enqueue({ kind: "turn-settled", event });
        }
        return Effect.void;
      }),
    );
    // No startup backfill. An action is created by work starting, and work
    // that started before this reactor did has already ended — reconstructing
    // actions for it would invent hand-offs the user never made.
  });

  return {
    start,
    drain: worker.drain,
  } satisfies BattleQueueReadinessReactorShape;
});

export const BattleQueueReadinessReactorLive = Layer.effect(BattleQueueReadinessReactor, make);
