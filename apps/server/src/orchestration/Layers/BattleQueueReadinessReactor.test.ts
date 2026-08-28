import {
  BattleId,
  BattleThreadGroupId,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  resolveQueueEntries,
  type OrchestrationSessionStatus,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { describe, expect } from "vite-plus/test";

import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { BattleQueueReadinessReactorLive } from "./BattleQueueReadinessReactor.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../ThreadPlanProgress.ts";
import { RuntimeReceiptBusTest } from "./RuntimeReceiptBus.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { BattleQueueReadinessReactor } from "../Services/BattleQueueReadinessReactor.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  RuntimeReceiptBus,
  type BattleQueueReadinessSettledReceipt,
} from "../Services/RuntimeReceiptBus.ts";
import { ServerConfig } from "../../config.ts";

const projectId = ProjectId.make("project-1");
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5-codex",
};

/** Monotonic ISO timestamps, so windowed reads keep messages in send order. */
let clockTick = 0;
const nextIso = () => {
  clockTick += 1;
  const millis = String(clockTick % 1000).padStart(3, "0");
  const seconds = String(Math.floor(clockTick / 1000) % 60).padStart(2, "0");
  return `2026-01-01T00:00:${seconds}.${millis}Z`;
};

const testLayer = BattleQueueReadinessReactorLive.pipe(
  Layer.provideMerge(
    OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(ThreadBackgroundLiveness.layer),
      Layer.provide(ThreadPlanProgress.layer),
      Layer.provide(OrchestrationProjectionPipelineLive),
      Layer.provide(OrchestrationEventStoreLive),
      Layer.provide(OrchestrationCommandReceiptRepositoryLive),
      Layer.provide(RepositoryIdentityResolver.layer),
      Layer.provide(SqlitePersistenceMemory),
    ),
  ),
  Layer.provideMerge(
    OrchestrationProjectionSnapshotQueryLive.pipe(
      Layer.provide(ThreadBackgroundLiveness.layer),
      Layer.provide(ThreadPlanProgress.layer),
      Layer.provide(RepositoryIdentityResolver.layer),
      Layer.provide(SqlitePersistenceMemory),
    ),
  ),
  Layer.provideMerge(RuntimeReceiptBusTest),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-battle-queue-test-" })),
  Layer.provideMerge(NodeServices.layer),
);

const makeHarness = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const snapshotQuery = yield* ProjectionSnapshotQuery;
  const reactor = yield* BattleQueueReadinessReactor;
  const receiptBus = yield* RuntimeReceiptBus;

  // Subscribed before anything can publish and before `start()`, so no receipt
  // is missed. Every decision this reactor reaches publishes one, which is what
  // lets each assertion below wait on a receipt instead of a sleep.
  const receipts = yield* Queue.unbounded<BattleQueueReadinessSettledReceipt>();
  yield* Stream.runForEach(receiptBus.streamEventsForTest, (receipt) =>
    receipt.type === "battle.queue.readiness-settled"
      ? Queue.offer(receipts, receipt)
      : Effect.void,
  ).pipe(Effect.forkScoped);

  yield* engine.dispatch({
    type: "project.create",
    commandId: CommandId.make("cmd-project-create"),
    projectId,
    title: "Test Project",
    workspaceRoot: process.cwd(),
    defaultModelSelection: modelSelection,
    createdAt: nextIso(),
  });

  const createBattle = (battleId: BattleId) =>
    engine.dispatch({
      type: "battle.create",
      commandId: CommandId.make(`cmd-battle-create-${battleId}`),
      battleId,
      projectId,
      title: `Battle ${battleId}`,
      createdAt: nextIso(),
    });

  const createThread = (input: { readonly threadId: ThreadId; readonly battleId: BattleId }) =>
    engine.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`cmd-thread-create-${input.threadId}`),
      threadId: input.threadId,
      projectId,
      battleId: input.battleId,
      title: `Thread ${input.threadId}`,
      modelSelection,
      runtimeMode: DEFAULT_RUNTIME_MODE,
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      branch: null,
      worktreePath: null,
      createdAt: nextIso(),
    });

  const enqueueBattle = (battleId: BattleId) =>
    engine.dispatch({
      type: "battle.queue.add",
      commandId: CommandId.make(`cmd-queue-add-${battleId}`),
      battleId,
      createdAt: nextIso(),
    });

  const startTurn = (threadId: ThreadId, tag: string) =>
    engine.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make(`cmd-turn-start-${tag}`),
      threadId,
      message: {
        messageId: MessageId.make(`message-${tag}`),
        role: "user",
        text: "Go.",
        attachments: [],
      },
      runtimeMode: DEFAULT_RUNTIME_MODE,
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      createdAt: nextIso(),
    });

  const setSessionStatus = (input: {
    readonly threadId: ThreadId;
    readonly status: OrchestrationSessionStatus;
    readonly tag: string;
  }) => {
    const updatedAt = nextIso();
    return engine.dispatch({
      type: "thread.session.set",
      commandId: CommandId.make(`cmd-session-set-${input.tag}`),
      threadId: input.threadId,
      session: {
        threadId: input.threadId,
        status: input.status,
        providerName: "codex",
        runtimeMode: DEFAULT_RUNTIME_MODE,
        activeTurnId: null,
        lastError: null,
        updatedAt,
      },
      createdAt: updatedAt,
    });
  };

  const queueEntry = (battleId: BattleId) =>
    snapshotQuery
      .getQueueEntryByBattleId(battleId)
      .pipe(Effect.map((entry) => (Option.isSome(entry) ? entry.value : null)));

  const groupThreads = (battleId: BattleId, threadIds: ReadonlyArray<ThreadId>) =>
    engine.dispatch({
      type: "battle.thread-groups.set",
      commandId: CommandId.make(`cmd-groups-${battleId}`),
      battleId,
      groups: [{ id: BattleThreadGroupId.make(`group-${battleId}`), threadIds }],
    });

  return {
    engine,
    snapshotQuery,
    start: reactor.start(),
    drain: reactor.drain,
    nextReceipt: Queue.take(receipts),
    createBattle,
    createThread,
    enqueueBattle,
    startTurn,
    setSessionStatus,
    queueEntry,
    groupThreads,
  };
});

type Harness = Effect.Success<typeof makeHarness>;

/** Fresh layer per test, so each one gets its own in-memory database. */
const withHarness = <A, E, R>(body: (harness: Harness) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const harness = yield* makeHarness;
    return yield* body(harness);
  }).pipe(Effect.scoped, Effect.provide(testLayer));

/** Waits for the first receipt about `threadId`, ignoring unrelated chatter. */
const receiptFor = (harness: Harness, threadId: ThreadId) =>
  Effect.gen(function* () {
    while (true) {
      const receipt = yield* harness.nextReceipt;
      if (receipt.threadId === threadId) return receipt;
    }
  });

describe("BattleQueueReadinessReactor", () => {
  it.live("opens an action when a turn starts in a queued battle", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const battleId = BattleId.make("battle-open");
        const threadId = ThreadId.make("thread-open");
        yield* harness.start;
        yield* harness.createBattle(battleId);
        yield* harness.createThread({ threadId, battleId });
        yield* harness.enqueueBattle(battleId);

        yield* harness.startTurn(threadId, "open");
        const receipt = yield* receiptFor(harness, threadId);
        expect(receipt.outcome).toBe("opened");
        expect(receipt.battleId).toBe(battleId);

        const entry = yield* harness.queueEntry(battleId);
        expect(entry?.actions).toHaveLength(1);
        expect(entry?.actions[0]?.threadIds).toEqual([threadId]);
        // The base rule: every thread in the action idle and awaiting you.
        expect(entry?.actions[0]?.wakeRule).toEqual({ kind: "all" });
        expect(entry?.actions[0]?.outcome).toBeNull();
      }),
    ),
  );

  it.live("ignores a turn in a battle nobody queued", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const battleId = BattleId.make("battle-unqueued");
        const threadId = ThreadId.make("thread-unqueued");
        yield* harness.start;
        yield* harness.createBattle(battleId);
        yield* harness.createThread({ threadId, battleId });

        yield* harness.startTurn(threadId, "unqueued");
        const receipt = yield* receiptFor(harness, threadId);
        expect(receipt.outcome).toBe("ignored");
        expect(receipt.battleId).toBeNull();
        expect(yield* harness.queueEntry(battleId)).toBeNull();
      }),
    ),
  );

  it.live("settles the action as completed when its thread goes idle", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const battleId = BattleId.make("battle-settle");
        const threadId = ThreadId.make("thread-settle");
        yield* harness.start;
        yield* harness.createBattle(battleId);
        yield* harness.createThread({ threadId, battleId });
        yield* harness.enqueueBattle(battleId);
        yield* harness.startTurn(threadId, "settle");
        expect((yield* receiptFor(harness, threadId)).outcome).toBe("opened");

        yield* harness.setSessionStatus({ threadId, status: "idle", tag: "settle-idle" });
        const receipt = yield* receiptFor(harness, threadId);
        expect(receipt.outcome).toBe("settled");
        expect(receipt.actionOutcome).toBe("completed");

        const entry = yield* harness.queueEntry(battleId);
        expect(entry?.actions[0]?.outcome).toBe("completed");
      }),
    ),
  );

  it.live("marks an action errored when its thread's session failed", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const battleId = BattleId.make("battle-error");
        const threadId = ThreadId.make("thread-error");
        yield* harness.start;
        yield* harness.createBattle(battleId);
        yield* harness.createThread({ threadId, battleId });
        yield* harness.enqueueBattle(battleId);
        yield* harness.startTurn(threadId, "error");
        expect((yield* receiptFor(harness, threadId)).outcome).toBe("opened");

        yield* harness.setSessionStatus({ threadId, status: "error", tag: "error-status" });
        const receipt = yield* receiptFor(harness, threadId);
        expect(receipt.outcome).toBe("settled");
        // Errored is the outcome you must not miss, so it wins the derivation.
        expect(receipt.actionOutcome).toBe("errored");
      }),
    ),
  );

  it.live("holds a grouped action until every thread in it is idle", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const battleId = BattleId.make("battle-group");
        const firstId = ThreadId.make("thread-group-first");
        const secondId = ThreadId.make("thread-group-second");
        yield* harness.start;
        yield* harness.createBattle(battleId);
        yield* harness.createThread({ threadId: firstId, battleId });
        yield* harness.createThread({ threadId: secondId, battleId });
        // One authored group, so one hand-off covers both threads.
        yield* harness.groupThreads(battleId, [firstId, secondId]);
        yield* harness.enqueueBattle(battleId);

        yield* harness.startTurn(firstId, "group-first");
        expect((yield* receiptFor(harness, firstId)).outcome).toBe("opened");
        yield* harness.startTurn(secondId, "group-second");
        // The second thread joins the open action rather than opening a rival.
        expect((yield* receiptFor(harness, secondId)).outcome).toBe("widened");

        const opened = yield* harness.queueEntry(battleId);
        expect(opened?.actions).toHaveLength(1);
        expect(opened?.actions[0]?.threadIds).toEqual([firstId, secondId]);

        // One thread back is not enough under the default "all" rule.
        yield* harness.setSessionStatus({
          threadId: firstId,
          status: "running",
          tag: "group-second-busy",
        });
        yield* harness.setSessionStatus({ threadId: secondId, status: "idle", tag: "group-half" });
        expect((yield* receiptFor(harness, secondId)).outcome).toBe("waiting");
        expect((yield* harness.queueEntry(battleId))?.actions[0]?.outcome).toBeNull();

        yield* harness.setSessionStatus({ threadId: firstId, status: "idle", tag: "group-full" });
        const settled = yield* receiptFor(harness, firstId);
        expect(settled.outcome).toBe("settled");
        expect((yield* harness.queueEntry(battleId))?.actions[0]?.outcome).toBe("completed");
      }),
    ),
  );

  it.live("wakes a grouped action on the first thread back when the rule says any", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const battleId = BattleId.make("battle-any");
        const firstId = ThreadId.make("thread-any-first");
        const secondId = ThreadId.make("thread-any-second");
        yield* harness.start;
        yield* harness.createBattle(battleId);
        yield* harness.createThread({ threadId: firstId, battleId });
        yield* harness.createThread({ threadId: secondId, battleId });
        yield* harness.groupThreads(battleId, [firstId, secondId]);
        yield* harness.enqueueBattle(battleId);

        yield* harness.startTurn(firstId, "any-first");
        const opened = yield* receiptFor(harness, firstId);
        yield* harness.startTurn(secondId, "any-second");
        yield* receiptFor(harness, secondId);

        const actionId = opened.actionId;
        if (actionId === null) throw new Error("expected an action id");
        yield* harness.engine.dispatch({
          type: "battle.queue.action.wake-rule.set",
          commandId: CommandId.make("cmd-wake-any"),
          battleId,
          actionId,
          wakeRule: { kind: "any" },
        });

        yield* harness.setSessionStatus({
          threadId: firstId,
          status: "running",
          tag: "any-first-busy",
        });
        yield* harness.setSessionStatus({ threadId: secondId, status: "idle", tag: "any-half" });
        const settled = yield* receiptFor(harness, secondId);
        expect(settled.outcome).toBe("settled");
      }),
    ),
  );

  it.live("treats a thread queued behind a shared worktree as busy", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const battleId = BattleId.make("battle-gated");
        const threadId = ThreadId.make("thread-gated");
        yield* harness.start;
        yield* harness.createBattle(battleId);
        yield* harness.createThread({ threadId, battleId });
        yield* harness.enqueueBattle(battleId);
        yield* harness.startTurn(threadId, "gated");
        expect((yield* receiptFor(harness, threadId)).outcome).toBe("opened");

        yield* harness.engine.dispatch({
          type: "thread.turn-queue.update",
          commandId: CommandId.make("cmd-turn-queued"),
          threadId,
          turnQueued: true,
          createdAt: nextIso(),
        });
        // Waiting on the TurnGate is just a flavour of busy: the action stays
        // in flight rather than surfacing a "blocked" state of its own.
        yield* harness.setSessionStatus({ threadId, status: "idle", tag: "gated-idle" });
        expect((yield* receiptFor(harness, threadId)).outcome).toBe("waiting");
        expect((yield* harness.queueEntry(battleId))?.actions[0]?.outcome).toBeNull();
      }),
    ),
  );

  it.live("settles one kick-off exactly once across repeated settle signals", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const battleId = BattleId.make("battle-once");
        const threadId = ThreadId.make("thread-once");
        yield* harness.start;
        yield* harness.createBattle(battleId);
        yield* harness.createThread({ threadId, battleId });
        yield* harness.enqueueBattle(battleId);
        yield* harness.startTurn(threadId, "once");
        expect((yield* receiptFor(harness, threadId)).outcome).toBe("opened");

        yield* harness.setSessionStatus({ threadId, status: "idle", tag: "once-first" });
        expect((yield* receiptFor(harness, threadId)).outcome).toBe("settled");

        // `thread.session-set` fires more than once around a settle; the repeat
        // must not produce a second wake.
        yield* harness.setSessionStatus({ threadId, status: "ready", tag: "once-second" });
        expect((yield* receiptFor(harness, threadId)).outcome).toBe("ignored");

        const entry = yield* harness.queueEntry(battleId);
        expect(entry?.actions).toHaveLength(1);
      }),
    ),
  );

  it.live("clears a skip when a settle re-readies a passed-over battle", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const battleId = BattleId.make("battle-skip-clear");
        const threadId = ThreadId.make("thread-skip-clear");
        // A second ready battle, so the skip below does not also exhaust the
        // lap and reset itself.
        const otherId = BattleId.make("battle-skip-other");
        const otherThreadId = ThreadId.make("thread-skip-other");
        yield* harness.start;
        yield* harness.createBattle(battleId);
        yield* harness.createThread({ threadId, battleId });
        yield* harness.enqueueBattle(battleId);
        yield* harness.createBattle(otherId);
        yield* harness.createThread({ threadId: otherThreadId, battleId: otherId });
        yield* harness.enqueueBattle(otherId);
        yield* harness.startTurn(otherThreadId, "skip-other");
        yield* receiptFor(harness, otherThreadId);
        yield* harness.setSessionStatus({
          threadId: otherThreadId,
          status: "idle",
          tag: "skip-other-ready",
        });
        yield* receiptFor(harness, otherThreadId);
        yield* harness.startTurn(threadId, "skip-clear");
        yield* receiptFor(harness, threadId);
        yield* harness.setSessionStatus({ threadId, status: "idle", tag: "skip-clear-ready" });
        yield* receiptFor(harness, threadId);

        yield* harness.engine.dispatch({
          type: "battle.queue.skip",
          commandId: CommandId.make("cmd-skip-clear"),
          battleId,
        });
        expect((yield* harness.queueEntry(battleId))?.skippedInLap).toBe(true);

        // Fresh work is new information, so the battle earns its place back.
        yield* harness.startTurn(threadId, "skip-clear-again");
        yield* receiptFor(harness, threadId);
        yield* harness.setSessionStatus({
          threadId,
          status: "idle",
          tag: "skip-clear-again-ready",
        });
        yield* receiptFor(harness, threadId);
        expect((yield* harness.queueEntry(battleId))?.skippedInLap).toBe(false);
      }),
    ),
  );

  it.live("stops tracking a battle once its row is cleared", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const battleId = BattleId.make("battle-dropped");
        const threadId = ThreadId.make("thread-dropped");
        yield* harness.start;
        yield* harness.createBattle(battleId);
        yield* harness.createThread({ threadId, battleId });
        yield* harness.enqueueBattle(battleId);
        yield* harness.startTurn(threadId, "dropped");
        expect((yield* receiptFor(harness, threadId)).outcome).toBe("opened");

        yield* harness.engine.dispatch({
          type: "battle.queue.remove",
          commandId: CommandId.make("cmd-remove-dropped"),
          battleIds: [battleId],
        });
        yield* harness.setSessionStatus({ threadId, status: "idle", tag: "dropped-idle" });
        expect((yield* receiptFor(harness, threadId)).outcome).toBe("ignored");

        const snapshot = yield* harness.snapshotQuery.getShellSnapshot();
        expect(resolveQueueEntries(snapshot.queueEntries)).toEqual([]);
      }),
    ),
  );
});
