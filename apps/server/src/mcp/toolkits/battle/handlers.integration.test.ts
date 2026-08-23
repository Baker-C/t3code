import { assert, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import {
  BattleId,
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  VictoryCondition,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { ServerConfig } from "../../../config.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../../persistence/Layers/Sqlite.ts";
import { OrchestrationEngineLive } from "../../../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../../../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../../../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { battleIdFromOrchestratorSendMessageId } from "../../../orchestration/battleOrchestrator.ts";
import * as ThreadBackgroundLiveness from "../../../orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../../../orchestration/ThreadPlanProgress.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as RepositoryIdentityResolver from "../../../project/RepositoryIdentityResolver.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { __testing } from "./handlers.ts";

const CREATED_AT = "2026-01-01T00:00:00.000Z";
const MODEL_SELECTION = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5-codex",
} as const;

/**
 * The real aggregate, not a stub: the point of this test is that a tool call
 * survives the whole path — handler, engine dispatch, decider invariants,
 * projector, and the SQL projection the next tool call reads back.
 */
const IntegrationLayer = OrchestrationEngineLive.pipe(
  Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
  Layer.provide(ThreadBackgroundLiveness.layer),
  Layer.provide(ThreadPlanProgress.layer),
  Layer.provide(OrchestrationProjectionPipelineLive),
  Layer.provide(OrchestrationEventStoreLive),
  Layer.provide(OrchestrationCommandReceiptRepositoryLive),
  Layer.provide(RepositoryIdentityResolver.layer),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), {
      prefix: "t3-mcp-battle-integration-",
    }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

interface BattleFixture {
  readonly battleId: BattleId;
  readonly callerThreadId: ThreadId;
  readonly mateThreadId: ThreadId;
  readonly orchestratorThreadId: ThreadId;
}

/**
 * One project, one battle, and two member threads per test. The suite shares a
 * database, so each fixture keys its ids off `name` to stay independent.
 */
const seedBattle = Effect.fn("seedBattle")(function* (name: string) {
  const engine = yield* OrchestrationEngineService;
  const projectId = ProjectId.make(`project-${name}`);
  const fixture: BattleFixture = {
    battleId: BattleId.make(`battle-${name}`),
    callerThreadId: ThreadId.make(`thread-caller-${name}`),
    mateThreadId: ThreadId.make(`thread-mate-${name}`),
    orchestratorThreadId: ThreadId.make(`thread-orchestrator-${name}`),
  };

  yield* engine.dispatch({
    type: "project.create",
    commandId: CommandId.make(`cmd-${name}-project`),
    projectId,
    title: "Integration Project",
    workspaceRoot: `/tmp/project-${name}`,
    defaultModelSelection: MODEL_SELECTION,
    createdAt: CREATED_AT,
  });

  yield* engine.dispatch({
    type: "battle.create",
    commandId: CommandId.make(`cmd-${name}-battle`),
    battleId: fixture.battleId,
    projectId,
    title: "Streaming Diffs",
    goal: "Diffs stream while the turn runs",
    createdAt: CREATED_AT,
  });

  for (const [threadId, title] of [
    [fixture.callerThreadId, "Frontend"],
    [fixture.mateThreadId, "Backend"],
    [fixture.orchestratorThreadId, "Orchestrator"],
  ] as const) {
    yield* engine.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`cmd-${name}-${title}`),
      threadId,
      projectId,
      battleId: fixture.battleId,
      title,
      modelSelection: MODEL_SELECTION,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: "battle/streaming-diffs",
      worktreePath: null,
      createdAt: CREATED_AT,
    });
  }

  return fixture;
});

/** Runs a tool call as the agent driving `threadId`, the way MCP would. */
const asCallingThread =
  (
    threadId: ThreadId,
    capabilities: ReadonlyArray<McpInvocationContext.McpCapability> = ["battle"],
  ) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, {
        environmentId: EnvironmentId.make("environment-1"),
        threadId,
        providerSessionId: "provider-session-1",
        providerInstanceId: ProviderInstanceId.make("codex"),
        capabilities: new Set<McpInvocationContext.McpCapability>(capabilities),
        issuedAt: 1,
      } satisfies McpInvocationContext.McpInvocationScope),
    );

/** Names the battle's orchestrator, the way the orchestrator reactor does. */
const setOrchestrator = Effect.fn("setOrchestrator")(function* (
  name: string,
  fixture: BattleFixture,
) {
  const engine = yield* OrchestrationEngineService;
  yield* engine.dispatch({
    type: "battle.orchestrator.set",
    commandId: CommandId.make(`cmd-${name}-orchestrator`),
    battleId: fixture.battleId,
    threadId: fixture.orchestratorThreadId,
  });
});

const readProjectedConditions = Effect.fn("readProjectedConditions")(function* (
  battleId: BattleId,
) {
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const battle = yield* projectionSnapshotQuery.getBattleById(battleId);
  assert.equal(Option.isSome(battle), true);
  return Option.isSome(battle)
    ? battle.value.victoryConditions
    : ([] as ReadonlyArray<VictoryCondition>);
});

it.layer(IntegrationLayer)("battle toolkit against the real orchestration engine", (it) => {
  it.effect("carries a tool-added condition through the decider into projected state", () =>
    Effect.gen(function* () {
      const fixture = yield* seedBattle("added");
      const asCaller = asCallingThread(fixture.callerThreadId);

      const added = yield* asCaller(
        __testing.handlers.battle_condition_add({
          title: "Mobile renders the stream",
          sizeProvisional: true,
        }),
      );

      // The handler mints the conditionId server-side; the decider accepting it
      // is what proves the two agree on the id format.
      expect(added.battleId).toBe(fixture.battleId);
      const conditions = yield* readProjectedConditions(fixture.battleId);
      expect(conditions).toHaveLength(1);
      expect(conditions[0]?.id).toBe(added.conditionId);
      expect(conditions[0]?.title).toBe("Mobile renders the stream");
      expect(conditions[0]?.state).toBe("unscoped");
      expect(conditions[0]?.sizeProvisional).toBe(true);
      // Attribution is the whole point of the MCP path: the agent's own thread
      // is stamped on the condition, exactly as a UI edit would be.
      expect(conditions[0]?.updatedByThreadId).toBe(fixture.callerThreadId);
    }),
  );

  it.effect("persists an agent update, including attribution, to the battle projection row", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const fixture = yield* seedBattle("updated");
      const asCaller = asCallingThread(fixture.callerThreadId);

      const added = yield* asCaller(
        __testing.handlers.battle_condition_add({ title: "Server streams diff chunks" }),
      );
      yield* asCaller(
        __testing.handlers.battle_condition_update({
          conditionId: added.conditionId,
          state: "scoped",
          sizeScore: 2,
        }),
      );

      const conditions = yield* readProjectedConditions(fixture.battleId);
      expect(conditions).toHaveLength(1);
      expect(conditions[0]?.state).toBe("scoped");
      expect(conditions[0]?.sizeScore).toBe(2);
      expect(conditions[0]?.updatedByThreadId).toBe(fixture.callerThreadId);
      // The title was not part of the update and must survive it.
      expect(conditions[0]?.title).toBe("Server streams diff chunks");

      const rows = yield* sql<{ readonly victoryConditionsJson: string }>`
        SELECT victory_conditions_json AS "victoryConditionsJson"
        FROM projection_battles
        WHERE battle_id = ${fixture.battleId}
      `;
      assert.equal(rows.length, 1);
      const persisted = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(Schema.Array(VictoryCondition)),
      )(rows[0]?.victoryConditionsJson ?? "[]");
      assert.equal(persisted.length, 1);
      assert.equal(persisted[0]?.state, "scoped");
      assert.equal(persisted[0]?.updatedByThreadId, fixture.callerThreadId);
    }),
  );

  it.effect("battle_status reads back the agent's own edits and the derived battle lines", () =>
    Effect.gen(function* () {
      const fixture = yield* seedBattle("status");
      const asCaller = asCallingThread(fixture.callerThreadId);

      const scoped = yield* asCaller(
        __testing.handlers.battle_condition_add({ title: "Survives scoping" }),
      );
      const struck = yield* asCaller(
        __testing.handlers.battle_condition_add({ title: "Gets struck" }),
      );

      const whileUnscoped = yield* asCaller(__testing.handlers.battle_status());
      expect(whileUnscoped.phase).toBe("scoping");
      // Nothing is resolved yet, so the battle lines cannot be drawn.
      expect(whileUnscoped.battleLinesDrawn).toBe(false);
      expect(whileUnscoped.victoryConditions).toHaveLength(2);

      yield* asCaller(
        __testing.handlers.battle_condition_update({
          conditionId: scoped.conditionId,
          state: "scoped",
          sizeScore: 3,
        }),
      );
      yield* asCaller(
        __testing.handlers.battle_condition_strike({
          conditionId: struck.conditionId,
          reason: "Superseded by the streaming rewrite",
        }),
      );

      const status = yield* asCaller(__testing.handlers.battle_status());
      expect(status.battleId).toBe(fixture.battleId);
      expect(status.title).toBe("Streaming Diffs");
      expect(status.goal).toBe("Diffs stream while the turn runs");
      // Every condition resolved and one survived: the lines are drawn.
      expect(status.battleLinesDrawn).toBe(true);

      const byId = new Map(status.victoryConditions.map((entry) => [entry.id, entry]));
      expect(byId.get(scoped.conditionId)?.state).toBe("scoped");
      expect(byId.get(scoped.conditionId)?.sizeScore).toBe(3);
      expect(byId.get(struck.conditionId)?.state).toBe("descoped");
      expect(byId.get(struck.conditionId)?.strikeReason).toBe(
        "Superseded by the streaming rewrite",
      );
      expect(byId.get(struck.conditionId)?.updatedByThreadId).toBe(fixture.callerThreadId);

      const battleThreads = status.threads.filter(
        (thread) =>
          thread.threadId === fixture.callerThreadId || thread.threadId === fixture.mateThreadId,
      );
      expect(battleThreads).toEqual([
        {
          threadId: fixture.callerThreadId,
          title: "Frontend",
          isCallingThread: true,
          isOrchestrator: false,
          branch: "battle/streaming-diffs",
          worktreePath: null,
          sessionStatus: null,
        },
        {
          threadId: fixture.mateThreadId,
          title: "Backend",
          isCallingThread: false,
          isOrchestrator: false,
          branch: "battle/streaming-diffs",
          worktreePath: null,
          sessionStatus: null,
        },
      ]);
    }),
  );

  it.effect("battle_status marks the orchestrator once the battle names one", () =>
    Effect.gen(function* () {
      const fixture = yield* seedBattle("orchestrated");
      yield* setOrchestrator("orchestrated", fixture);

      const status = yield* asCallingThread(fixture.callerThreadId)(
        __testing.handlers.battle_status(),
      );

      const byId = new Map(status.threads.map((thread) => [thread.threadId, thread]));
      expect(byId.get(fixture.orchestratorThreadId)?.isOrchestrator).toBe(true);
      expect(byId.get(fixture.callerThreadId)?.isOrchestrator).toBe(false);
    }),
  );

  it.effect("battle_thread_send drives a real turn into a member thread", () =>
    Effect.gen(function* () {
      const fixture = yield* seedBattle("send");
      yield* setOrchestrator("send", fixture);
      const asOrchestrator = asCallingThread(fixture.orchestratorThreadId, [
        "battle",
        "battle-orchestrator",
      ]);

      const sent = yield* asOrchestrator(
        __testing.orchestratorHandlers.battle_thread_send({
          threadId: fixture.mateThreadId,
          message: "Scope the projector change",
        }),
      );

      expect(sent).toEqual({ threadId: fixture.mateThreadId, queued: false });

      // The decider accepted the command, so the message is in the member's
      // own projected transcript, marked as orchestrator-initiated.
      const messages = yield* asOrchestrator(
        __testing.orchestratorHandlers.battle_thread_read({ threadId: fixture.mateThreadId }),
      );
      expect(messages.messages).toHaveLength(1);
      const only = messages.messages[0];
      expect(only?.role).toBe("user");
      expect(only?.text).toBe("Scope the projector change");
      expect(battleIdFromOrchestratorSendMessageId(only?.messageId ?? MessageId.make("x"))).toBe(
        fixture.battleId,
      );
    }),
  );

  it.effect("refuses a target outside the battle and the orchestrator itself", () =>
    Effect.gen(function* () {
      const fixture = yield* seedBattle("refusals");
      yield* setOrchestrator("refusals", fixture);
      const asOrchestrator = asCallingThread(fixture.orchestratorThreadId, [
        "battle",
        "battle-orchestrator",
      ]);

      const outsider = yield* asOrchestrator(
        __testing.orchestratorHandlers
          .battle_thread_send({
            threadId: ThreadId.make("thread-caller-send"),
            message: "wrong battle",
          })
          .pipe(Effect.flip),
      );
      expect(outsider.reason).toBe("target-not-in-battle");

      const self = yield* asOrchestrator(
        __testing.orchestratorHandlers
          .battle_thread_send({
            threadId: fixture.orchestratorThreadId,
            message: "talking to myself",
          })
          .pipe(Effect.flip),
      );
      expect(self.reason).toBe("target-is-orchestrator");

      // A member of the same battle holds only the plain battle capability.
      const member = yield* asCallingThread(fixture.callerThreadId)(
        __testing.orchestratorHandlers
          .battle_thread_read({ threadId: fixture.mateThreadId })
          .pipe(Effect.flip),
      );
      expect(member.reason).toBe("not-orchestrator");
    }),
  );
});
