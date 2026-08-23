import { expect, it } from "@effect/vitest";
import {
  BattleId,
  EnvironmentId,
  IsoDateTime,
  MessageId,
  type OrchestrationBattle,
  type OrchestrationCommand,
  type OrchestrationMessage,
  type OrchestrationSession,
  type OrchestrationShellSnapshot,
  type OrchestrationThread,
  type OrchestrationThreadDetailWindow,
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

import { battleIdFromOrchestratorSendMessageId } from "../../../orchestration/battleOrchestrator.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { __testing } from "./handlers.ts";
import { BattleToolError } from "./tools.ts";

const battleId = BattleId.make("battle-1");
const callerThreadId = ThreadId.make("thread-caller");
const mateThreadId = ThreadId.make("thread-mate");
const orchestratorThreadId = ThreadId.make("thread-orchestrator");
const outsiderThreadId = ThreadId.make("thread-outsider");
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
  orchestratorThreadId: null,
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

/** The same battle, but with its manager thread named. */
const battleWithOrchestrator: OrchestrationBattle = { ...battle, orchestratorThreadId };

const runningSession = (threadId: ThreadId): OrchestrationSession => ({
  threadId,
  status: "running",
  providerName: "codex",
  runtimeMode: "auto",
  activeTurnId: null,
  lastError: null,
  updatedAt: timestamp,
});

const defaultThreads: ReadonlyArray<OrchestrationThreadShell> = [
  threadShell(callerThreadId, { title: "Frontend" }),
  threadShell(mateThreadId, { title: "Backend", worktreePath: "/repos/backend" }),
  threadShell(outsiderThreadId, { battleId: null, title: "Unrelated" }),
];

/** The member roster plus the battle's own orchestrator thread. */
const threadsWithOrchestrator: ReadonlyArray<OrchestrationThreadShell> = [
  ...defaultThreads,
  threadShell(orchestratorThreadId, {
    title: "Orchestrator",
    branch: null,
    worktreePath: null,
  }),
];

const shellSnapshotOf = (
  threads: ReadonlyArray<OrchestrationThreadShell>,
): OrchestrationShellSnapshot => ({
  snapshotSequence: 1,
  projects: [],
  threads,
  battles: [battle],
  updatedAt: timestamp,
});

const threadDetail = (
  shell: OrchestrationThreadShell,
  messages: ReadonlyArray<OrchestrationMessage>,
): OrchestrationThread => ({
  ...shell,
  deletedAt: null,
  messages,
  proposedPlans: [],
  activities: [],
  checkpoints: [],
});

const message = (id: string, role: "user" | "assistant", text: string): OrchestrationMessage => ({
  id: MessageId.make(id),
  role,
  text,
  turnId: null,
  streaming: false,
  createdAt: timestamp,
  updatedAt: timestamp,
});

interface ProjectionOptions {
  readonly thread?: OrchestrationThreadShell | null;
  readonly battle?: OrchestrationBattle;
  readonly threads?: ReadonlyArray<OrchestrationThreadShell>;
  readonly messages?: ReadonlyArray<OrchestrationMessage>;
  /** Collects the windows `battle_thread_read` asks for, so the test can pin them. */
  readonly detailWindows?: Array<OrchestrationThreadDetailWindow | undefined>;
}

const projectionLayer = (
  thread: OrchestrationThreadShell | null,
  options: ProjectionOptions = {},
) =>
  Layer.succeed(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
    getThreadShellById: () => Effect.succeed(thread === null ? Option.none() : Option.some(thread)),
    getBattleById: () => Effect.succeed(Option.some(options.battle ?? battle)),
    getShellSnapshot: () => Effect.succeed(shellSnapshotOf(options.threads ?? defaultThreads)),
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
    getThreadDetailSnapshot: (threadId, window) => {
      options.detailWindows?.push(window);
      const shell = (options.threads ?? defaultThreads).find((entry) => entry.id === threadId);
      return Effect.succeed(
        shell === undefined
          ? Option.none()
          : Option.some({
              snapshotSequence: 1,
              thread: threadDetail(shell, options.messages ?? []),
            }),
      );
    },
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
  threadId: ThreadId = callerThreadId,
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment-1"),
  threadId,
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
  options?: ProjectionOptions & {
    readonly dispatched?: Array<OrchestrationCommand>;
    readonly capabilities?: ReadonlyArray<McpInvocationContext.McpCapability>;
    readonly callerThreadId?: ThreadId;
  },
) =>
  effect.pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(
          McpInvocationContext.McpInvocationContext,
          invocationScope(
            options?.capabilities ?? ["battle"],
            options?.callerThreadId ?? callerThreadId,
          ),
        ),
        projectionLayer(
          options?.thread === undefined
            ? threadShell(options?.callerThreadId ?? callerThreadId)
            : options.thread,
          options ?? {},
        ),
        engineLayer(options?.dispatched ?? []),
        NodeServices.layer,
      ),
    ),
  );

/** Everything the orchestrator toolkit needs to see the caller as the manager. */
const asOrchestrator = {
  capabilities: [
    "battle",
    "battle-orchestrator",
  ] as ReadonlyArray<McpInvocationContext.McpCapability>,
  callerThreadId: orchestratorThreadId,
  battle: battleWithOrchestrator,
  threads: threadsWithOrchestrator,
};

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
        isOrchestrator: false,
        branch: "battle/streaming-diff",
        worktreePath: "/repos/frontend",
        sessionStatus: null,
      },
      {
        threadId: mateThreadId,
        title: "Backend",
        isCallingThread: false,
        isOrchestrator: false,
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

it.effect("battle_status marks the battle's orchestrator for a member thread", () =>
  Effect.gen(function* () {
    const status = yield* run(__testing.handlers.battle_status(), {
      battle: battleWithOrchestrator,
      threads: threadsWithOrchestrator,
    });

    const byId = new Map(status.threads.map((thread) => [thread.threadId, thread]));
    expect(byId.get(orchestratorThreadId)?.isOrchestrator).toBe(true);
    expect(byId.get(callerThreadId)?.isOrchestrator).toBe(false);
    expect(byId.get(mateThreadId)?.isOrchestrator).toBe(false);
    // The member sees the manager without being one.
    expect(byId.get(callerThreadId)?.isCallingThread).toBe(true);
  }),
);

it.effect("refuses the orchestrator tools to a member thread", () =>
  Effect.gen(function* () {
    const dispatched: Array<OrchestrationCommand> = [];
    const sendError = yield* run(
      __testing.orchestratorHandlers
        .battle_thread_send({ threadId: mateThreadId, message: "do the thing" })
        .pipe(Effect.flip),
      { battle: battleWithOrchestrator, threads: threadsWithOrchestrator, dispatched },
    );
    const readError = yield* run(
      __testing.orchestratorHandlers
        .battle_thread_read({ threadId: mateThreadId })
        .pipe(Effect.flip),
      { battle: battleWithOrchestrator, threads: threadsWithOrchestrator },
    );

    expect(sendError).toBeInstanceOf(BattleToolError);
    expect(sendError.reason).toBe("not-orchestrator");
    expect(readError.reason).toBe("not-orchestrator");
    expect(dispatched).toHaveLength(0);
  }),
);

it.effect("refuses a credential that claims orchestrator scope the battle does not confirm", () =>
  Effect.gen(function* () {
    const dispatched: Array<OrchestrationCommand> = [];
    const error = yield* run(
      __testing.orchestratorHandlers
        .battle_thread_send({ threadId: mateThreadId, message: "do the thing" })
        .pipe(Effect.flip),
      {
        // Stale credential: the capability is there, the battle disagrees.
        capabilities: ["battle", "battle-orchestrator"],
        threads: threadsWithOrchestrator,
        dispatched,
      },
    );

    expect(error.reason).toBe("not-orchestrator");
    expect(dispatched).toHaveLength(0);
  }),
);

it.effect("battle_thread_send starts exactly one orchestrator-marked turn in a member", () =>
  Effect.gen(function* () {
    const dispatched: Array<OrchestrationCommand> = [];
    const result = yield* run(
      __testing.orchestratorHandlers.battle_thread_send({
        threadId: mateThreadId,
        message: "Scope the projector change",
      }),
      { ...asOrchestrator, dispatched },
    );

    expect(result).toEqual({ threadId: mateThreadId, queued: false });
    expect(dispatched).toHaveLength(1);
    const command = dispatched[0];
    expect(command).toMatchObject({
      type: "thread.turn.start",
      threadId: mateThreadId,
      message: { role: "user", text: "Scope the projector change", attachments: [] },
    });
    // The reactor recognises the turn from this id alone, so it is the contract.
    const messageId =
      command?.type === "thread.turn.start" ? command.message.messageId : "not-a-send";
    expect(battleIdFromOrchestratorSendMessageId(messageId)).toBe(battleId);
    // `bootstrap` is a WebSocket-path concern; engine.dispatch ignores it.
    expect(command).not.toHaveProperty("bootstrap");
  }),
);

it.effect("battle_thread_send queues behind a busy target instead of failing", () =>
  Effect.gen(function* () {
    const dispatched: Array<OrchestrationCommand> = [];
    const result = yield* run(
      __testing.orchestratorHandlers.battle_thread_send({
        threadId: mateThreadId,
        message: "Report back when you land",
      }),
      {
        ...asOrchestrator,
        threads: threadsWithOrchestrator.map((thread) =>
          thread.id === mateThreadId
            ? { ...thread, session: runningSession(mateThreadId) }
            : thread,
        ),
        dispatched,
      },
    );

    expect(result.queued).toBe(true);
    // Queued is a report, not a refusal: the turn is still dispatched.
    expect(dispatched).toHaveLength(1);
  }),
);

it.effect("battle_thread_send refuses a target outside the caller's battle", () =>
  Effect.gen(function* () {
    const dispatched: Array<OrchestrationCommand> = [];
    const error = yield* run(
      __testing.orchestratorHandlers
        .battle_thread_send({ threadId: outsiderThreadId, message: "hello" })
        .pipe(Effect.flip),
      { ...asOrchestrator, dispatched },
    );

    expect(error.reason).toBe("target-not-in-battle");
    expect(dispatched).toHaveLength(0);
  }),
);

it.effect("battle_thread_send refuses an unknown target", () =>
  Effect.gen(function* () {
    const dispatched: Array<OrchestrationCommand> = [];
    const error = yield* run(
      __testing.orchestratorHandlers
        .battle_thread_send({ threadId: ThreadId.make("thread-archived"), message: "hello" })
        .pipe(Effect.flip),
      { ...asOrchestrator, dispatched },
    );

    // Not in the shell snapshot: archived and deleted threads are unreachable.
    expect(error.reason).toBe("target-not-in-battle");
    expect(dispatched).toHaveLength(0);
  }),
);

it.effect("battle_thread_send refuses the orchestrator itself as a target", () =>
  Effect.gen(function* () {
    const dispatched: Array<OrchestrationCommand> = [];
    const error = yield* run(
      __testing.orchestratorHandlers
        .battle_thread_send({ threadId: orchestratorThreadId, message: "talking to myself" })
        .pipe(Effect.flip),
      { ...asOrchestrator, dispatched },
    );

    expect(error.reason).toBe("target-is-orchestrator");
    expect(dispatched).toHaveLength(0);
  }),
);

it.effect("battle_thread_read returns a member's most recent messages, oldest first", () =>
  Effect.gen(function* () {
    const detailWindows: Array<OrchestrationThreadDetailWindow | undefined> = [];
    const result = yield* run(
      __testing.orchestratorHandlers.battle_thread_read({ threadId: mateThreadId, limit: 2 }),
      {
        ...asOrchestrator,
        detailWindows,
        messages: [
          message("msg-1", "user", "first"),
          message("msg-2", "assistant", "second"),
          message("msg-3", "user", "third"),
        ],
      },
    );

    expect(result.threadId).toBe(mateThreadId);
    expect(result.title).toBe("Backend");
    expect(result.messages.map((entry) => entry.text)).toEqual(["second", "third"]);
    expect(result.messages[1]).toEqual({
      messageId: MessageId.make("msg-3"),
      role: "user",
      text: "third",
      createdAt: timestamp,
    });
    // Windowed, never the whole thread body.
    expect(detailWindows).toEqual([{ turnLimit: 2 }]);
  }),
);

it.effect("battle_thread_read caps and defaults its limit", () =>
  Effect.gen(function* () {
    const detailWindows: Array<OrchestrationThreadDetailWindow | undefined> = [];
    yield* run(__testing.orchestratorHandlers.battle_thread_read({ threadId: mateThreadId }), {
      ...asOrchestrator,
      detailWindows,
    });
    yield* run(
      __testing.orchestratorHandlers.battle_thread_read({ threadId: mateThreadId, limit: 5_000 }),
      { ...asOrchestrator, detailWindows },
    );

    expect(detailWindows).toEqual([{ turnLimit: 20 }, { turnLimit: 100 }]);
  }),
);

it.effect("battle_thread_read refuses a thread outside the caller's battle", () =>
  Effect.gen(function* () {
    const error = yield* run(
      __testing.orchestratorHandlers
        .battle_thread_read({ threadId: outsiderThreadId })
        .pipe(Effect.flip),
      asOrchestrator,
    );

    expect(error.reason).toBe("target-not-in-battle");
  }),
);
