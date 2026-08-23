import { expect, it } from "@effect/vitest";
import {
  BattleId,
  EnvironmentId,
  IsoDateTime,
  type OrchestrationBattle,
  type OrchestrationCommand,
  type OrchestrationShellSnapshot,
  type OrchestrationThreadShell,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  VictoryConditionId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { __testing } from "./handlers.ts";
import { BattleToolError } from "./tools.ts";

const battleId = BattleId.make("battle-1");
const callerThreadId = ThreadId.make("thread-caller");
const mateThreadId = ThreadId.make("thread-mate");
const timestamp = IsoDateTime.make("2026-01-01T00:00:00.000Z");

const threadShell = (
  id: ThreadId,
  overrides: Partial<OrchestrationThreadShell> = {},
): OrchestrationThreadShell => ({
  id,
  projectId: ProjectId.make("project-1"),
  battleId,
  title: "Thread",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  runtimeMode: "auto",
  interactionMode: "default",
  branch: "battle/streaming-diff",
  worktreePath: "/repos/frontend",
  latestTurn: null,
  createdAt: timestamp,
  updatedAt: timestamp,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  session: null,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
  ...overrides,
});

const battle: OrchestrationBattle = {
  id: battleId,
  projectId: ProjectId.make("project-1"),
  title: "Streaming diffs",
  goal: "Diffs stream while the turn runs",
  slug: "streaming-diffs",
  phase: "scoping",
  victoryConditions: [
    {
      id: VictoryConditionId.make("condition-1"),
      title: "Server streams diff chunks",
      state: "scoped",
      sizeScore: 3,
      sizeProvisional: false,
      ownerThreadId: callerThreadId,
      strikeReason: null,
      updatedByThreadId: callerThreadId,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  ],
  defeatedAt: null,
  createdAt: timestamp,
  updatedAt: timestamp,
  deletedAt: null,
};

const shellSnapshot: OrchestrationShellSnapshot = {
  snapshotSequence: 1,
  projects: [],
  threads: [
    threadShell(callerThreadId, { title: "Frontend" }),
    threadShell(mateThreadId, { title: "Backend", worktreePath: "/repos/backend" }),
    threadShell(ThreadId.make("thread-outsider"), { battleId: null, title: "Unrelated" }),
  ],
  battles: [battle],
  updatedAt: timestamp,
};

const projectionLayer = (thread: OrchestrationThreadShell | null) =>
  Layer.succeed(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
    getThreadShellById: () => Effect.succeed(thread === null ? Option.none() : Option.some(thread)),
    getBattleById: () => Effect.succeed(Option.some(battle)),
    getShellSnapshot: () => Effect.succeed(shellSnapshot),
    getCommandReadModel: () => Effect.die("unexpected getCommandReadModel"),
    getSnapshot: () => Effect.die("unexpected getSnapshot"),
    getArchivedShellSnapshot: () => Effect.die("unexpected getArchivedShellSnapshot"),
    searchThreads: () => Effect.die("unexpected searchThreads"),
    getSnapshotSequence: () => Effect.die("unexpected getSnapshotSequence"),
    getCounts: () => Effect.die("unexpected getCounts"),
    getActiveProjectByWorkspaceRoot: () => Effect.die("unexpected getActiveProjectByWorkspaceRoot"),
    getProjectShellById: () => Effect.die("unexpected getProjectShellById"),
    getFirstActiveThreadIdByProjectId: () =>
      Effect.die("unexpected getFirstActiveThreadIdByProjectId"),
    getThreadCheckpointContext: () => Effect.die("unexpected getThreadCheckpointContext"),
    getWorktreeOccupancy: () => Effect.succeed({ threads: [], projects: [] }),
    getFullThreadDiffContext: () => Effect.die("unexpected getFullThreadDiffContext"),
    getThreadDetailById: () => Effect.die("unexpected getThreadDetailById"),
    getThreadDetailSnapshot: () => Effect.die("unexpected getThreadDetailSnapshot"),
  });

const engineLayer = (dispatched: Array<OrchestrationCommand>) =>
  Layer.succeed(OrchestrationEngineService, {
    dispatch: (command) =>
      Effect.sync(() => {
        dispatched.push(command);
        return { sequence: dispatched.length };
      }),
    readEvents: () => Stream.empty,
    streamDomainEvents: Stream.empty,
    latestSequence: Effect.succeed(0),
  });

const invocationScope = (
  capabilities: ReadonlyArray<McpInvocationContext.McpCapability>,
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment-1"),
  threadId: callerThreadId,
  providerSessionId: "provider-session-1",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(capabilities),
  issuedAt: 1,
});

const run = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    | Crypto.Crypto
    | McpInvocationContext.McpInvocationContext
    | OrchestrationEngineService
    | ProjectionSnapshotQuery.ProjectionSnapshotQuery
  >,
  options?: {
    readonly dispatched?: Array<OrchestrationCommand>;
    readonly capabilities?: ReadonlyArray<McpInvocationContext.McpCapability>;
    readonly thread?: OrchestrationThreadShell | null;
  },
) =>
  effect.pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(
          McpInvocationContext.McpInvocationContext,
          invocationScope(options?.capabilities ?? ["battle"]),
        ),
        projectionLayer(
          options?.thread === undefined ? threadShell(callerThreadId) : options.thread,
        ),
        engineLayer(options?.dispatched ?? []),
        NodeServices.layer,
      ),
    ),
  );

it.effect("battle_status reports the battle, its conditions, and its member threads", () =>
  Effect.gen(function* () {
    const status = yield* run(__testing.handlers.battle_status());

    expect(status.battleId).toBe(battleId);
    expect(status.phase).toBe("scoping");
    // One scoped condition and nothing unresolved: the lines are drawn.
    expect(status.battleLinesDrawn).toBe(true);
    expect(status.victoryConditions).toHaveLength(1);
    expect(status.threads).toEqual([
      {
        threadId: callerThreadId,
        title: "Frontend",
        isCallingThread: true,
        branch: "battle/streaming-diff",
        worktreePath: "/repos/frontend",
        sessionStatus: null,
      },
      {
        threadId: mateThreadId,
        title: "Backend",
        isCallingThread: false,
        branch: "battle/streaming-diff",
        worktreePath: "/repos/backend",
        sessionStatus: null,
      },
    ]);
  }),
);

it.effect("battle_condition_add attributes the new condition to the calling thread", () =>
  Effect.gen(function* () {
    const dispatched: Array<OrchestrationCommand> = [];
    const result = yield* run(
      __testing.handlers.battle_condition_add({
        title: "Mobile renders the stream",
        state: "unscoped",
        sizeProvisional: true,
      }),
      { dispatched },
    );

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toMatchObject({
      type: "battle.condition.add",
      battleId,
      conditionId: result.conditionId,
      title: "Mobile renders the stream",
      state: "unscoped",
      sizeProvisional: true,
      updatedByThreadId: callerThreadId,
    });
    // Omitted optional fields must not be sent as explicit clears.
    expect(dispatched[0]).not.toHaveProperty("sizeScore");
    expect(result.battleId).toBe(battleId);
  }),
);

it.effect("battle_condition_update sends only the stated fields plus attribution", () =>
  Effect.gen(function* () {
    const dispatched: Array<OrchestrationCommand> = [];
    const conditionId = VictoryConditionId.make("condition-1");
    yield* run(
      __testing.handlers.battle_condition_update({ conditionId, state: "scoped", sizeScore: 2 }),
      { dispatched },
    );

    expect(dispatched[0]).toEqual({
      type: "battle.condition.update",
      commandId: expect.stringContaining("server:battle-condition-update:"),
      battleId,
      conditionId,
      state: "scoped",
      sizeScore: 2,
      updatedByThreadId: callerThreadId,
    });
  }),
);

it.effect("battle_condition_strike carries the reason and the attributing thread", () =>
  Effect.gen(function* () {
    const dispatched: Array<OrchestrationCommand> = [];
    const conditionId = VictoryConditionId.make("condition-1");
    yield* run(
      __testing.handlers.battle_condition_strike({
        conditionId,
        reason: "Superseded by the streaming rewrite",
      }),
      { dispatched },
    );

    expect(dispatched[0]).toMatchObject({
      type: "battle.condition.strike",
      battleId,
      conditionId,
      strikeReason: "Superseded by the streaming rewrite",
      updatedByThreadId: callerThreadId,
    });
  }),
);

it.effect("refuses every tool when the credential lacks the battle capability", () =>
  Effect.gen(function* () {
    const dispatched: Array<OrchestrationCommand> = [];
    const error = yield* run(__testing.handlers.battle_status().pipe(Effect.flip), {
      capabilities: ["preview"],
      dispatched,
    });

    expect(error).toBeInstanceOf(BattleToolError);
    expect(error.reason).toBe("capability-unavailable");
    expect(dispatched).toHaveLength(0);
  }),
);

it.effect("refuses when the calling thread is not part of a battle", () =>
  Effect.gen(function* () {
    const dispatched: Array<OrchestrationCommand> = [];
    const error = yield* run(
      __testing.handlers.battle_condition_add({ title: "Orphan condition" }).pipe(Effect.flip),
      { thread: threadShell(callerThreadId, { battleId: null }), dispatched },
    );

    expect(error.reason).toBe("thread-not-in-battle");
    expect(dispatched).toHaveLength(0);
  }),
);
