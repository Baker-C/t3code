import {
  BattleId,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  VictoryConditionId,
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

import { ORCHESTRATOR_THREAD_TITLE, orchestratorSendMessageId } from "../battleOrchestrator.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { BattleOrchestratorReactorLive } from "./BattleOrchestratorReactor.ts";
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
import { BattleOrchestratorReactor } from "../Services/BattleOrchestratorReactor.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  RuntimeReceiptBus,
  type BattleOrchestratorBackfillSettledReceipt,
  type BattleOrchestratorReadyReceipt,
  type BattleOrchestratorReportSettledReceipt,
} from "../Services/RuntimeReceiptBus.ts";
import { ServerConfig } from "../../config.ts";

type OrchestratorReceipt =
  | BattleOrchestratorReadyReceipt
  | BattleOrchestratorBackfillSettledReceipt
  | BattleOrchestratorReportSettledReceipt;

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

const testLayer = BattleOrchestratorReactorLive.pipe(
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
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), { prefix: "t3-battle-orchestrator-test-" }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

const makeHarness = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const snapshotQuery = yield* ProjectionSnapshotQuery;
  const reactor = yield* BattleOrchestratorReactor;
  const receiptBus = yield* RuntimeReceiptBus;

  // Subscribed before anything can publish, and before `start()` is called, so
  // no receipt is missed. Every milestone this reactor reaches publishes one,
  // which is what lets every assertion below wait on a receipt instead of a
  // sleep. The collector is forked into the test scope, which interrupts it.
  const receipts = yield* Queue.unbounded<OrchestratorReceipt>();
  yield* Stream.runForEach(receiptBus.streamEventsForTest, (receipt) =>
    receipt.type === "battle.orchestrator.ready" ||
    receipt.type === "battle.orchestrator.backfill-settled" ||
    receipt.type === "battle.orchestrator.report-settled"
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

  const createBattle = (input: {
    readonly battleId: BattleId;
    readonly title?: string;
    readonly defeated?: boolean;
    readonly deleted?: boolean;
  }) =>
    Effect.gen(function* () {
      yield* engine.dispatch({
        type: "battle.create",
        commandId: CommandId.make(`cmd-battle-create-${input.battleId}`),
        battleId: input.battleId,
        projectId,
        title: input.title ?? `Battle ${input.battleId}`,
        createdAt: nextIso(),
      });
      if (input.defeated === true) {
        yield* engine.dispatch({
          type: "battle.condition.add",
          commandId: CommandId.make(`cmd-battle-condition-${input.battleId}`),
          battleId: input.battleId,
          conditionId: VictoryConditionId.make(`condition-${input.battleId}`),
          title: "Ship it",
          state: "scoped",
        });
        yield* engine.dispatch({
          type: "battle.declare-fighting",
          commandId: CommandId.make(`cmd-battle-fighting-${input.battleId}`),
          battleId: input.battleId,
        });
        yield* engine.dispatch({
          type: "battle.declare-defeat",
          commandId: CommandId.make(`cmd-battle-defeat-${input.battleId}`),
          battleId: input.battleId,
          retireWorktrees: false,
        });
      }
      if (input.deleted === true) {
        yield* engine.dispatch({
          type: "battle.delete",
          commandId: CommandId.make(`cmd-battle-delete-${input.battleId}`),
          battleId: input.battleId,
        });
      }
    });

  const createThread = (input: {
    readonly threadId: ThreadId;
    readonly battleId: BattleId;
    readonly title?: string;
  }) =>
    engine.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`cmd-thread-create-${input.threadId}`),
      threadId: input.threadId,
      projectId,
      battleId: input.battleId,
      title: input.title ?? `Thread ${input.threadId}`,
      modelSelection,
      runtimeMode: DEFAULT_RUNTIME_MODE,
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      branch: null,
      worktreePath: null,
      createdAt: nextIso(),
    });

  const startTurn = (input: {
    readonly threadId: ThreadId;
    readonly messageId: MessageId;
    readonly text: string;
  }) =>
    engine.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make(`cmd-turn-start-${input.messageId}`),
      threadId: input.threadId,
      message: {
        messageId: input.messageId,
        role: "user",
        text: input.text,
        attachments: [],
      },
      runtimeMode: DEFAULT_RUNTIME_MODE,
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      createdAt: nextIso(),
    });

  const replyAssistant = (input: {
    readonly threadId: ThreadId;
    readonly messageId: MessageId;
    readonly text: string;
  }) =>
    Effect.gen(function* () {
      yield* engine.dispatch({
        type: "thread.message.assistant.delta",
        commandId: CommandId.make(`cmd-assistant-delta-${input.messageId}`),
        threadId: input.threadId,
        messageId: input.messageId,
        delta: input.text,
        createdAt: nextIso(),
      });
      yield* engine.dispatch({
        type: "thread.message.assistant.complete",
        commandId: CommandId.make(`cmd-assistant-complete-${input.messageId}`),
        threadId: input.threadId,
        messageId: input.messageId,
        createdAt: nextIso(),
      });
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

  /** One orchestrator-initiated member turn, from send to settle. */
  const runOrchestratorInitiatedTurn = (input: {
    readonly battleId: BattleId;
    readonly threadId: ThreadId;
    readonly tag: string;
    readonly reply: string;
  }) =>
    Effect.gen(function* () {
      yield* startTurn({
        threadId: input.threadId,
        messageId: orchestratorSendMessageId({ battleId: input.battleId, uuid: input.tag }),
        text: "Status?",
      });
      yield* replyAssistant({
        threadId: input.threadId,
        messageId: MessageId.make(`assistant-${input.tag}`),
        text: input.reply,
      });
      yield* setSessionStatus({ threadId: input.threadId, status: "idle", tag: input.tag });
    });

  const threadMessages = (threadId: ThreadId) =>
    snapshotQuery
      .getThreadDetailSnapshot(threadId)
      .pipe(
        Effect.map((detail) =>
          Option.isSome(detail) ? detail.value.thread.messages : ([] as const),
        ),
      );

  return {
    engine,
    snapshotQuery,
    start: reactor.start(),
    drain: reactor.drain,
    nextReceipt: Queue.take(receipts),
    takeAllReceipts: Queue.takeAll(receipts),
    createBattle,
    createThread,
    startTurn,
    replyAssistant,
    setSessionStatus,
    runOrchestratorInitiatedTurn,
    threadMessages,
  };
});

type Harness = Effect.Success<typeof makeHarness>;

/** Fresh layer per test, so each one gets its own in-memory database. */
const withHarness = <A, E, R>(body: (harness: Harness) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const harness = yield* makeHarness;
    return yield* body(harness);
  }).pipe(Effect.scoped, Effect.provide(testLayer));

/** Narrows a receipt to `ready`, failing the test rather than the type checker. */
const expectReady = (receipt: OrchestratorReceipt): BattleOrchestratorReadyReceipt => {
  expect(receipt.type).toBe("battle.orchestrator.ready");
  if (receipt.type !== "battle.orchestrator.ready") {
    throw new Error("expected a ready receipt");
  }
  return receipt;
};

const expectReport = (receipt: OrchestratorReceipt): BattleOrchestratorReportSettledReceipt => {
  expect(receipt.type).toBe("battle.orchestrator.report-settled");
  if (receipt.type !== "battle.orchestrator.report-settled") {
    throw new Error("expected a report-settled receipt");
  }
  return receipt;
};

describe("BattleOrchestratorReactor", () => {
  it.live("mints exactly one worktree-less orchestrator thread when a battle is created", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const battleId = BattleId.make("battle-created");
        yield* harness.start;
        // The startup pass over an empty database settles first.
        expect((yield* harness.nextReceipt).type).toBe("battle.orchestrator.backfill-settled");

        yield* harness.createBattle({ battleId });
        const ready = expectReady(yield* harness.nextReceipt);
        expect(ready.battleId).toBe(battleId);
        expect(ready.source).toBe("created");

        const battle = yield* harness.snapshotQuery.getBattleById(battleId);
        expect(Option.isSome(battle)).toBe(true);
        if (Option.isSome(battle)) {
          expect(battle.value.orchestratorThreadId).toBe(ready.orchestratorThreadId);
        }

        const orchestrator = yield* harness.snapshotQuery.getThreadShellById(
          ready.orchestratorThreadId,
        );
        expect(Option.isSome(orchestrator)).toBe(true);
        if (Option.isSome(orchestrator)) {
          expect(orchestrator.value.title).toBe(ORCHESTRATOR_THREAD_TITLE);
          expect(orchestrator.value.battleId).toBe(battleId);
          // Manager only: no branch and no worktree is what makes it run on
          // the project root.
          expect(orchestrator.value.branch).toBeNull();
          expect(orchestrator.value.worktreePath).toBeNull();
        }

        const shell = yield* harness.snapshotQuery.getShellSnapshot();
        const orchestrators = shell.threads.filter(
          (thread) => thread.battleId === battleId && thread.title === ORCHESTRATOR_THREAD_TITLE,
        );
        expect(orchestrators).toHaveLength(1);
      }),
    ),
  );

  it.live("backfills only the live, undefeated battles that have no orchestrator", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const adoptedId = BattleId.make("battle-adopt");
        const boundId = BattleId.make("battle-bound");
        const defeatedId = BattleId.make("battle-defeated");
        const deletedId = BattleId.make("battle-deleted");

        // Seeded before `start()`, so the hot domain stream never carries
        // these creations and only the backfill can reach them.
        yield* harness.createBattle({ battleId: adoptedId });
        yield* harness.createBattle({ battleId: boundId });
        yield* harness.createThread({
          threadId: ThreadId.make("thread-bound-orchestrator"),
          battleId: boundId,
        });
        yield* harness.engine.dispatch({
          type: "battle.orchestrator.set",
          commandId: CommandId.make("cmd-orchestrator-set-existing"),
          battleId: boundId,
          threadId: ThreadId.make("thread-bound-orchestrator"),
        });
        yield* harness.createBattle({ battleId: defeatedId, defeated: true });
        yield* harness.createBattle({ battleId: deletedId, deleted: true });

        yield* harness.start;

        const ready = expectReady(yield* harness.nextReceipt);
        expect(ready.battleId).toBe(adoptedId);
        expect(ready.source).toBe("backfilled");

        const settled = yield* harness.nextReceipt;
        expect(settled.type).toBe("battle.orchestrator.backfill-settled");
        if (settled.type === "battle.orchestrator.backfill-settled") {
          expect(settled.adopted).toEqual([adoptedId]);
        }

        const bound = yield* harness.snapshotQuery.getBattleById(boundId);
        if (Option.isSome(bound)) {
          expect(bound.value.orchestratorThreadId).toBe(ThreadId.make("thread-bound-orchestrator"));
        }
        const defeated = yield* harness.snapshotQuery.getBattleById(defeatedId);
        if (Option.isSome(defeated)) {
          expect(defeated.value.orchestratorThreadId).toBeNull();
        }
      }),
    ),
  );

  it.live("mints one orchestrator when both the created and backfill paths see a battle", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const battleId = BattleId.make("battle-both-paths");
        yield* harness.start;
        expect((yield* harness.nextReceipt).type).toBe("battle.orchestrator.backfill-settled");

        // `battle.created` is now queued on the worker. A second startup pass
        // taken before the worker gets to it sees a battle with no
        // orchestrator, so the same battle is handed to both paths at once.
        yield* harness.createBattle({ battleId });
        yield* harness.start;

        const collected: Array<OrchestratorReceipt> = [];
        let ready: BattleOrchestratorReadyReceipt | null = null;
        while (ready === null) {
          const receipt = yield* harness.nextReceipt;
          collected.push(receipt);
          if (receipt.type === "battle.orchestrator.ready") {
            ready = receipt;
          }
        }
        // Both entries have now been through the single consumer, so anything
        // the loser published would already be on the queue.
        yield* harness.drain;
        const rest = yield* harness.takeAllReceipts;
        const readies = [...collected, ...rest].filter(
          (receipt) => receipt.type === "battle.orchestrator.ready",
        );
        expect(readies).toHaveLength(1);

        const shell = yield* harness.snapshotQuery.getShellSnapshot();
        const orchestrators = shell.threads.filter((thread) => thread.battleId === battleId);
        expect(orchestrators).toHaveLength(1);
        expect(orchestrators[0]?.id).toBe(ready.orchestratorThreadId);

        const battle = yield* harness.snapshotQuery.getBattleById(battleId);
        if (Option.isSome(battle)) {
          expect(battle.value.orchestratorThreadId).toBe(ready.orchestratorThreadId);
        }
      }),
    ),
  );

  it.live("starts one orchestrator turn for members that settle back to back", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const battleId = BattleId.make("battle-back-to-back");
        const firstId = ThreadId.make("thread-first");
        const secondId = ThreadId.make("thread-second");
        yield* harness.start;
        yield* harness.nextReceipt;
        yield* harness.createBattle({ battleId });
        const ready = expectReady(yield* harness.nextReceipt);
        yield* harness.createThread({ threadId: firstId, battleId, title: "First" });
        yield* harness.createThread({ threadId: secondId, battleId, title: "Second" });

        // No session status is ever set on the orchestrator here, so the
        // projection calls it idle throughout. Only the in-flight mark from
        // our own dispatch can hold guard 3.
        yield* harness.runOrchestratorInitiatedTurn({
          battleId,
          threadId: firstId,
          tag: "send-1",
          reply: "First is done.",
        });
        const firstReport = expectReport(yield* harness.nextReceipt);
        expect(firstReport.outcome).toBe("delivered");
        expect(firstReport.deliveredFor).toEqual([firstId]);

        yield* harness.runOrchestratorInitiatedTurn({
          battleId,
          threadId: secondId,
          tag: "send-2",
          reply: "Second is done.",
        });
        const secondReport = expectReport(yield* harness.nextReceipt);
        expect(secondReport.outcome).toBe("buffered");

        // One turn started across both settles, not two.
        const messages = yield* harness.threadMessages(ready.orchestratorThreadId);
        expect(messages.filter((message) => message.role === "user")).toHaveLength(1);

        // The orchestrator settling is the only thing that releases the mark.
        yield* harness.setSessionStatus({
          threadId: ready.orchestratorThreadId,
          status: "idle",
          tag: "free",
        });
        const delivered = expectReport(yield* harness.nextReceipt);
        expect(delivered.outcome).toBe("delivered");
        expect(delivered.deliveredFor).toEqual([secondId]);

        const after = yield* harness.threadMessages(ready.orchestratorThreadId);
        const reportMessages = after.filter((message) => message.role === "user");
        expect(reportMessages).toHaveLength(2);
        expect(reportMessages[0]?.text).toContain("First is done.");
        expect(reportMessages[1]?.text).toContain("Second is done.");
      }),
    ),
  );

  it.live("reports an orchestrator-initiated member turn back exactly once", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const battleId = BattleId.make("battle-report");
        const memberId = ThreadId.make("thread-member");
        yield* harness.start;
        yield* harness.nextReceipt;
        yield* harness.createBattle({ battleId });
        const ready = expectReady(yield* harness.nextReceipt);
        yield* harness.createThread({ threadId: memberId, battleId, title: "Frontend" });

        yield* harness.runOrchestratorInitiatedTurn({
          battleId,
          threadId: memberId,
          tag: "send-1",
          reply: "The diff streams now.",
        });

        const report = expectReport(yield* harness.nextReceipt);
        expect(report.outcome).toBe("delivered");
        expect(report.memberThreadId).toBe(memberId);
        expect(report.deliveredFor).toEqual([memberId]);

        const messages = yield* harness.threadMessages(ready.orchestratorThreadId);
        const reportMessages = messages.filter((message) => message.role === "user");
        expect(reportMessages).toHaveLength(1);
        expect(reportMessages[0]?.text).toContain("Frontend");
        expect(reportMessages[0]?.text).toContain("The diff streams now.");

        // A second settle on the same send is the same edge, not a new one.
        yield* harness.setSessionStatus({ threadId: memberId, status: "idle", tag: "repeat" });
        const repeat = expectReport(yield* harness.nextReceipt);
        expect(repeat.outcome).toBe("ignored");
        const afterRepeat = yield* harness.threadMessages(ready.orchestratorThreadId);
        expect(afterRepeat.filter((message) => message.role === "user")).toHaveLength(1);
      }),
    ),
  );

  it.live("ignores a member turn the user started", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const battleId = BattleId.make("battle-user-turn");
        const memberId = ThreadId.make("thread-member");
        yield* harness.start;
        yield* harness.nextReceipt;
        yield* harness.createBattle({ battleId });
        const ready = expectReady(yield* harness.nextReceipt);
        yield* harness.createThread({ threadId: memberId, battleId });

        // A plain message id: the orchestrator marker is absent, so guard 1
        // must refuse to nudge the manager.
        yield* harness.startTurn({
          threadId: memberId,
          messageId: MessageId.make("user-typed-this"),
          text: "Do the thing",
        });
        yield* harness.replyAssistant({
          threadId: memberId,
          messageId: MessageId.make("assistant-user-turn"),
          text: "Done",
        });
        yield* harness.setSessionStatus({ threadId: memberId, status: "idle", tag: "user-turn" });

        const report = expectReport(yield* harness.nextReceipt);
        expect(report.outcome).toBe("ignored");
        expect(report.deliveredFor).toEqual([]);

        const messages = yield* harness.threadMessages(ready.orchestratorThreadId);
        expect(messages).toHaveLength(0);
      }),
    ),
  );

  it.live("never reports the orchestrator's own turn back to itself", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const battleId = BattleId.make("battle-self");
        const memberId = ThreadId.make("thread-member");
        yield* harness.start;
        yield* harness.nextReceipt;
        yield* harness.createBattle({ battleId });
        const ready = expectReady(yield* harness.nextReceipt);
        yield* harness.createThread({ threadId: memberId, battleId, title: "Backend" });

        // The orchestrator finishing its own turn publishes nothing: the next
        // receipt on the queue is the member's, which is how this proves the
        // negative without a timeout.
        yield* harness.startTurn({
          threadId: ready.orchestratorThreadId,
          messageId: MessageId.make("orchestrator-own-turn"),
          text: "Plan the work",
        });
        yield* harness.setSessionStatus({
          threadId: ready.orchestratorThreadId,
          status: "idle",
          tag: "self",
        });

        yield* harness.runOrchestratorInitiatedTurn({
          battleId,
          threadId: memberId,
          tag: "send-1",
          reply: "Backend is green.",
        });

        const report = expectReport(yield* harness.nextReceipt);
        expect(report.outcome).toBe("delivered");
        expect(report.memberThreadId).toBe(memberId);
      }),
    ),
  );

  it.live("coalesces replies that land while the orchestrator is mid-turn", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const battleId = BattleId.make("battle-coalesce");
        const firstId = ThreadId.make("thread-first");
        const secondId = ThreadId.make("thread-second");
        yield* harness.start;
        yield* harness.nextReceipt;
        yield* harness.createBattle({ battleId });
        const ready = expectReady(yield* harness.nextReceipt);
        yield* harness.createThread({ threadId: firstId, battleId, title: "First" });
        yield* harness.createThread({ threadId: secondId, battleId, title: "Second" });

        yield* harness.setSessionStatus({
          threadId: ready.orchestratorThreadId,
          status: "running",
          tag: "busy",
        });

        yield* harness.runOrchestratorInitiatedTurn({
          battleId,
          threadId: firstId,
          tag: "send-1",
          reply: "First is done.",
        });
        const firstReport = expectReport(yield* harness.nextReceipt);
        expect(firstReport.outcome).toBe("buffered");

        yield* harness.runOrchestratorInitiatedTurn({
          battleId,
          threadId: secondId,
          tag: "send-2",
          reply: "Second is done.",
        });
        const secondReport = expectReport(yield* harness.nextReceipt);
        expect(secondReport.outcome).toBe("buffered");

        expect(yield* harness.threadMessages(ready.orchestratorThreadId)).toHaveLength(0);

        // The orchestrator settling is what releases the whole buffer.
        yield* harness.setSessionStatus({
          threadId: ready.orchestratorThreadId,
          status: "idle",
          tag: "free",
        });
        const delivered = expectReport(yield* harness.nextReceipt);
        expect(delivered.outcome).toBe("delivered");
        expect(delivered.memberThreadId).toBeNull();
        expect(delivered.deliveredFor).toEqual([firstId, secondId]);

        const messages = yield* harness.threadMessages(ready.orchestratorThreadId);
        const reportMessages = messages.filter((message) => message.role === "user");
        expect(reportMessages).toHaveLength(1);
        expect(reportMessages[0]?.text).toContain("First is done.");
        expect(reportMessages[0]?.text).toContain("Second is done.");
      }),
    ),
  );
});
