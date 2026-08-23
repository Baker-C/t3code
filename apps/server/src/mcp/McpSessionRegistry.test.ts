import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  BattleId,
  EnvironmentId,
  IsoDateTime,
  type OrchestrationBattle,
  type OrchestrationThreadShell,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpServer } from "effect/unstable/http";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { layerTest as serverSettingsLayerTest } from "../serverSettings.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";

const environmentId = EnvironmentId.make("environment-1");
const makeFakeHttpServer = (hostname: string, port = 43123) =>
  HttpServer.HttpServer.of({
    address: { _tag: "TcpAddress", hostname, port },
    serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
  });
const fakeHttpServer = makeFakeHttpServer("127.0.0.1");
const fakeEnvironment = ServerEnvironment.ServerEnvironment.of({
  getEnvironmentId: Effect.succeed(environmentId),
  getDescriptor: Effect.die("unused"),
});

const threadShell = (threadId: ThreadId, battleId: BattleId | null): OrchestrationThreadShell => ({
  id: threadId,
  projectId: ProjectId.make("project-1"),
  battleId,
  title: "Thread",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  runtimeMode: "auto",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt: IsoDateTime.make("2026-01-01T00:00:00.000Z"),
  updatedAt: IsoDateTime.make("2026-01-01T00:00:00.000Z"),
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  session: null,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
});

const battle = (
  battleId: BattleId,
  orchestratorThreadId: ThreadId | null,
): OrchestrationBattle => ({
  id: battleId,
  projectId: ProjectId.make("project-1"),
  title: "Streaming diffs",
  goal: null,
  slug: "streaming-diffs",
  phase: "scoping",
  victoryConditions: [],
  orchestratorThreadId,
  defeatedAt: null,
  createdAt: IsoDateTime.make("2026-01-01T00:00:00.000Z"),
  updatedAt: IsoDateTime.make("2026-01-01T00:00:00.000Z"),
  deletedAt: null,
});

// Only the thread and its battle are reachable from the registry; every other
// query dies so a new read shows up as a failing test rather than a silent
// default.
const projectionLayer = (battleId: BattleId | null, orchestratorThreadId: ThreadId | null = null) =>
  Layer.succeed(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
    getThreadShellById: (threadId) => Effect.succeed(Option.some(threadShell(threadId, battleId))),
    getCommandReadModel: () => Effect.die("unexpected getCommandReadModel"),
    getSnapshot: () => Effect.die("unexpected getSnapshot"),
    getShellSnapshot: () => Effect.die("unexpected getShellSnapshot"),
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
    getBattleById: (requestedBattleId) =>
      Effect.succeed(Option.some(battle(requestedBattleId, orchestratorThreadId))),
    getThreadDetailSnapshot: () => Effect.die("unexpected getThreadDetailSnapshot"),
  });

const makeRegistry = (
  now: () => number,
  options?: {
    readonly httpServer?: HttpServer.HttpServer["Service"];
    readonly enableBattleTools?: boolean;
    readonly enableAgentBrowserAccess?: boolean;
    readonly battleId?: BattleId | null;
    readonly orchestratorThreadId?: ThreadId | null;
  },
) =>
  McpSessionRegistry.__testing
    .make({
      now,
      livenessWindowMs: 100,
    })
    .pipe(
      Effect.provideService(HttpServer.HttpServer, options?.httpServer ?? fakeHttpServer),
      Effect.provideService(ServerEnvironment.ServerEnvironment, fakeEnvironment),
      Effect.provide(
        Layer.mergeAll(
          projectionLayer(options?.battleId ?? null, options?.orchestratorThreadId ?? null),
          serverSettingsLayerTest({
            enableAgentBrowserAccess: options?.enableAgentBrowserAccess ?? true,
            enableBattleTools: options?.enableBattleTools ?? false,
          }),
          NodeServices.layer,
        ),
      ),
    );

it.effect("stores only a token hash, resolves the bearer token, and revokes by thread", () =>
  Effect.gen(function* () {
    let timestamp = 1_000;
    const registry = yield* makeRegistry(() => timestamp);
    const threadId = ThreadId.make("thread-1");
    const issued = yield* registry.issue({
      threadId,
      providerInstanceId: ProviderInstanceId.make("codex"),
    });
    expect(issued.config.endpoint).toBe("http://127.0.0.1:43123/mcp");
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");
    expect(token.length).toBeGreaterThan(20);

    const resolved = yield* registry.resolve(token);
    expect(resolved?.threadId).toBe(threadId);

    yield* registry.revokeThread(threadId);
    expect(yield* registry.resolve(token)).toBeUndefined();

    timestamp += 2_000;
  }),
);

it.effect("grants the battle capability only to battle threads with the setting on", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread-battle");
    const providerInstanceId = ProviderInstanceId.make("codex");
    const cases = [
      { enableBattleTools: true, battleId: BattleId.make("battle-1"), expected: true },
      { enableBattleTools: true, battleId: null, expected: false },
      { enableBattleTools: false, battleId: BattleId.make("battle-1"), expected: false },
    ] as const;

    for (const testCase of cases) {
      const registry = yield* makeRegistry(() => 1_000, {
        enableBattleTools: testCase.enableBattleTools,
        battleId: testCase.battleId,
      });
      const issued = yield* registry.issue({ threadId, providerInstanceId });
      const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");
      const scope = yield* registry.resolve(token);
      expect(scope?.capabilities.has("battle")).toBe(testCase.expected);
      expect(issued.config.capabilities.includes("battle")).toBe(testCase.expected);
      // Browser access is a separate switch; battle tools never imply preview.
      expect(scope?.capabilities.has("preview")).toBe(true);
    }
  }),
);

it.effect("grants the orchestrator capability only to the battle's orchestrator thread", () =>
  Effect.gen(function* () {
    const orchestratorThreadId = ThreadId.make("thread-orchestrator");
    const memberThreadId = ThreadId.make("thread-member");
    const providerInstanceId = ProviderInstanceId.make("codex");
    const battleId = BattleId.make("battle-orchestrated");
    const cases = [
      {
        name: "the orchestrator itself",
        threadId: orchestratorThreadId,
        enableBattleTools: true,
        orchestratorThreadId,
        expected: true,
      },
      {
        name: "a member of the same battle",
        threadId: memberThreadId,
        enableBattleTools: true,
        orchestratorThreadId,
        expected: false,
      },
      {
        name: "a battle with no orchestrator yet",
        threadId: orchestratorThreadId,
        enableBattleTools: true,
        orchestratorThreadId: null,
        expected: false,
      },
      {
        name: "the orchestrator with battle tools off",
        threadId: orchestratorThreadId,
        enableBattleTools: false,
        orchestratorThreadId,
        expected: false,
      },
    ] as const;

    for (const testCase of cases) {
      const registry = yield* makeRegistry(() => 1_000, {
        enableBattleTools: testCase.enableBattleTools,
        battleId,
        orchestratorThreadId: testCase.orchestratorThreadId,
      });
      const issued = yield* registry.issue({ threadId: testCase.threadId, providerInstanceId });
      const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");
      const scope = yield* registry.resolve(token);
      expect(
        scope?.capabilities.has("battle-orchestrator"),
        `${testCase.name} should ${testCase.expected ? "" : "not "}be an orchestrator`,
      ).toBe(testCase.expected);
      expect(issued.config.capabilities.includes("battle-orchestrator")).toBe(testCase.expected);
      // The orchestrator capability never replaces the plain battle one.
      expect(scope?.capabilities.has("battle")).toBe(testCase.enableBattleTools);
    }
  }),
);

it.effect("withholds the preview capability when agent browser access is off", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry(() => 1_000, {
      enableAgentBrowserAccess: false,
      enableBattleTools: true,
      battleId: BattleId.make("battle-2"),
    });
    const issued = yield* registry.issue({
      threadId: ThreadId.make("thread-battle-only"),
      providerInstanceId: ProviderInstanceId.make("codex"),
    });
    expect(issued.config.capabilities).toEqual(["battle"]);
  }),
);

it.effect("builds MCP endpoints from the bound server host", () =>
  Effect.gen(function* () {
    const cases = [
      ["100.64.0.40", "http://100.64.0.40:43123/mcp"],
      ["0.0.0.0", "http://127.0.0.1:43123/mcp"],
      ["localhost", "http://localhost:43123/mcp"],
      ["127.0.0.1", "http://127.0.0.1:43123/mcp"],
    ] as const;

    for (const [hostname, expectedEndpoint] of cases) {
      const registry = yield* makeRegistry(() => 1_000, {
        httpServer: makeFakeHttpServer(hostname),
      });
      const issued = yield* registry.issue({
        threadId: ThreadId.make(`thread-${hostname}`),
        providerInstanceId: ProviderInstanceId.make("codex"),
      });
      expect(issued.config.endpoint).toBe(expectedEndpoint);
    }
  }),
);

it.effect("expires credentials once their session stops showing signs of life", () =>
  Effect.gen(function* () {
    let timestamp = 1_000;
    const registry = yield* makeRegistry(() => timestamp);
    const issued = yield* registry.issue({
      threadId: ThreadId.make("thread-2"),
      providerInstanceId: ProviderInstanceId.make("claude"),
    });
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");
    timestamp += 101;
    expect(yield* registry.resolve(token)).toBeUndefined();
  }),
);

it.effect("keeps a credential alive across turns that never touch an MCP tool", () =>
  Effect.gen(function* () {
    let timestamp = 1_000;
    const registry = yield* makeRegistry(() => timestamp);
    const threadId = ThreadId.make("thread-3");
    const issued = yield* registry.issue({
      threadId,
      providerInstanceId: ProviderInstanceId.make("claude"),
    });
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");

    // Well past the liveness window in total, but each turn reports in before
    // it lapses — this is the long-session case that used to lose the toolkit.
    for (let turn = 0; turn < 10; turn += 1) {
      timestamp += 99;
      yield* registry.touch(threadId);
    }

    expect((yield* registry.resolve(token))?.threadId).toBe(threadId);
  }),
);

it.effect("does not keep credentials of other threads alive", () =>
  Effect.gen(function* () {
    let timestamp = 1_000;
    const registry = yield* makeRegistry(() => timestamp);
    const issued = yield* registry.issue({
      threadId: ThreadId.make("thread-4"),
      providerInstanceId: ProviderInstanceId.make("codex"),
    });
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");

    timestamp += 99;
    yield* registry.touch(ThreadId.make("thread-unrelated"));
    timestamp += 2;

    expect(yield* registry.resolve(token)).toBeUndefined();
  }),
);
