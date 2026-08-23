// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";

import {
  BattleId,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  VictoryConditionId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { describe, expect } from "vite-plus/test";

import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import { VcsStatusBroadcaster } from "../../vcs/VcsStatusBroadcaster.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { BattleRetirementReactorLive } from "./BattleRetirementReactor.ts";
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
import { BattleRetirementReactor } from "../Services/BattleRetirementReactor.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  RuntimeReceiptBus,
  type BattleWorktreeRetirementSettledReceipt,
} from "../Services/RuntimeReceiptBus.ts";
import { ServerConfig } from "../../config.ts";

const battleId = BattleId.make("battle-1");
const projectId = ProjectId.make("project-1");
const createdAt = "2026-01-01T00:00:00.000Z";

function runGit(cwd: string, args: ReadonlyArray<string>) {
  return NodeChildProcess.execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
}

function createGitRepository() {
  const cwd = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-battle-retirement-"));
  runGit(cwd, ["init", "--initial-branch=main"]);
  runGit(cwd, ["config", "user.email", "test@example.com"]);
  runGit(cwd, ["config", "user.name", "Test User"]);
  NodeFS.writeFileSync(NodePath.join(cwd, "README.md"), "v1\n", "utf8");
  runGit(cwd, ["add", "."]);
  runGit(cwd, ["commit", "-m", "Initial"]);
  return cwd;
}

/** Adds a linked worktree on a fresh branch and returns its absolute path. */
function addWorktree(repositoryRoot: string, branch: string) {
  const worktreePath = NodePath.join(repositoryRoot, "..", `wt-${branch}`);
  runGit(repositoryRoot, ["worktree", "add", "-b", branch, worktreePath, "main"]);
  return NodeFS.realpathSync(worktreePath);
}

function worktreeExists(repositoryRoot: string, worktreePath: string): boolean {
  const listed = runGit(repositoryRoot, ["worktree", "list", "--porcelain"]);
  return listed.replaceAll("\\", "/").includes(worktreePath.replaceAll("\\", "/"));
}

function branchExists(repositoryRoot: string, branch: string): boolean {
  try {
    runGit(repositoryRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

/** Registers a directory for removal when the enclosing test scope closes. */
const scopedTempDir = (create: () => string) =>
  Effect.acquireRelease(Effect.sync(create), (dir) =>
    Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true })),
  );

/**
 * Only the dirty/clean decision is stubbed; the worktree removal itself runs
 * against the real repository. `dirtyPaths` is read at call time so a test can
 * mark a worktree dirty after the layer is built.
 */
function makeTestLayer(dirtyPaths: ReadonlySet<string>) {
  const orchestrationLayer = OrchestrationEngineLive.pipe(
    Layer.provide(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(ThreadBackgroundLiveness.layer),
    Layer.provide(ThreadPlanProgress.layer),
    Layer.provide(OrchestrationProjectionPipelineLive),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolver.layer),
    Layer.provide(SqlitePersistenceMemory),
  );
  const projectionSnapshotLayer = OrchestrationProjectionSnapshotQueryLive.pipe(
    Layer.provide(ThreadBackgroundLiveness.layer),
    Layer.provide(ThreadPlanProgress.layer),
    Layer.provide(RepositoryIdentityResolver.layer),
    Layer.provide(SqlitePersistenceMemory),
  );

  const vcsStatusBroadcasterLayer = Layer.succeed(VcsStatusBroadcaster, {
    getStatus: () => Effect.die("getStatus should not be called in this test"),
    refreshLocalStatus: (cwd: string) =>
      Effect.succeed({
        isRepo: true,
        hasPrimaryRemote: false,
        isDefaultRef: false,
        refName: "battle-branch",
        hasWorkingTreeChanges: dirtyPaths.has(cwd.replaceAll("\\", "/")),
        workingTree: { files: [], insertions: 0, deletions: 0 },
      }),
    refreshStatus: () => Effect.die("refreshStatus should not be called in this test"),
    streamStatus: () => Stream.empty,
  });

  return BattleRetirementReactorLive.pipe(
    Layer.provideMerge(orchestrationLayer),
    Layer.provideMerge(projectionSnapshotLayer),
    Layer.provideMerge(RuntimeReceiptBusTest),
    Layer.provideMerge(vcsStatusBroadcasterLayer),
    Layer.provideMerge(GitVcsDriver.layer),
    Layer.provideMerge(VcsProcess.layer),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-battle-retirement-test-" }),
    ),
    Layer.provideMerge(NodeServices.layer),
  );
}

const makeHarness = (dirtyPaths: Set<string>) =>
  Effect.gen(function* () {
    const repositoryRoot = yield* scopedTempDir(createGitRepository);

    const engine = yield* OrchestrationEngineService;
    const snapshotQuery = yield* ProjectionSnapshotQuery;
    const reactor = yield* BattleRetirementReactor;
    const receiptBus = yield* RuntimeReceiptBus;

    // Subscribe before anything can publish, so no receipt is missed. The
    // collector is forked into the test scope, which also interrupts it.
    //
    // The reactor consumes domain events through a stream fiber, so `drain`
    // alone can return before the event is even enqueued. Every defeat settles
    // with exactly one receipt, so taking from this queue is the precise
    // milestone to wait on — no polling, no sleeps.
    const receipts = yield* Queue.unbounded<BattleWorktreeRetirementSettledReceipt>();
    yield* Stream.runForEach(receiptBus.streamEventsForTest, (receipt) =>
      receipt.type === "battle.worktree-retirement.settled"
        ? Queue.offer(receipts, receipt)
        : Effect.void,
    ).pipe(Effect.forkScoped);

    yield* reactor.start();

    yield* engine.dispatch({
      type: "project.create",
      commandId: CommandId.make("cmd-project-create"),
      projectId,
      title: "Test Project",
      workspaceRoot: repositoryRoot,
      defaultModelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      createdAt,
    });

    const createThread = (input: {
      readonly threadId: string;
      readonly worktreePath: string | null;
      readonly branch: string | null;
      readonly battleId: BattleId | null;
      readonly archived?: boolean;
    }) =>
      engine
        .dispatch({
          type: "thread.create",
          commandId: CommandId.make(`cmd-thread-create-${input.threadId}`),
          threadId: ThreadId.make(input.threadId),
          projectId,
          title: `Thread ${input.threadId}`,
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: input.branch,
          worktreePath: input.worktreePath,
          ...(input.battleId ? { battleId: input.battleId } : {}),
          createdAt,
        })
        .pipe(
          input.archived
            ? Effect.andThen(
                engine.dispatch({
                  type: "thread.archive",
                  commandId: CommandId.make(`cmd-thread-archive-${input.threadId}`),
                  threadId: ThreadId.make(input.threadId),
                }),
              )
            : Effect.asVoid,
        );

    const createBattle = Effect.gen(function* () {
      yield* engine.dispatch({
        type: "battle.create",
        commandId: CommandId.make("cmd-battle-create"),
        battleId,
        projectId,
        title: "Streaming diff",
        createdAt,
      });
      // battle.declare-fighting is guarded by battleLinesDrawn, so the battle
      // needs at least one scoped condition before it can be defeated.
      yield* engine.dispatch({
        type: "battle.condition.add",
        commandId: CommandId.make("cmd-battle-condition-add"),
        battleId,
        conditionId: VictoryConditionId.make("condition-1"),
        title: "Ship it",
        state: "scoped",
      });
      yield* engine.dispatch({
        type: "battle.declare-fighting",
        commandId: CommandId.make("cmd-battle-declare-fighting"),
        battleId,
      });
    });

    const declareDefeat = (retireWorktrees: boolean) =>
      engine.dispatch({
        type: "battle.declare-defeat",
        commandId: CommandId.make("cmd-battle-declare-defeat"),
        battleId,
        retireWorktrees,
      });

    return {
      engine,
      repositoryRoot,
      createThread,
      createBattle,
      declareDefeat,
      nextReceipt: Queue.take(receipts),
      drain: reactor.drain,
      markDirty: (worktreePath: string) => {
        dirtyPaths.add(worktreePath.replaceAll("\\", "/"));
      },
      readModel: snapshotQuery.getSnapshot(),
      addWorktree: (branch: string) => scopedTempDir(() => addWorktree(repositoryRoot, branch)),
    };
  });

type Harness = Effect.Effect.Success<ReturnType<typeof makeHarness>>;

/**
 * Builds a fresh layer per test so each one gets its own in-memory database,
 * repository, and dirty-path stub state.
 */
const withHarness = <A, E, R>(body: (harness: Harness) => Effect.Effect<A, E, R>) => {
  const dirtyPaths = new Set<string>();
  return Effect.gen(function* () {
    const harness = yield* makeHarness(dirtyPaths);
    return yield* body(harness);
  }).pipe(Effect.scoped, Effect.provide(makeTestLayer(dirtyPaths)));
};

describe("BattleRetirementReactor", () => {
  it.live("removes an exclusively owned clean worktree and clears it from its threads", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const worktreePath = yield* harness.addWorktree("battle-streaming-diff");
        yield* harness.createBattle;
        yield* harness.createThread({
          threadId: "thread-1",
          worktreePath,
          branch: "battle-streaming-diff",
          battleId,
        });

        yield* harness.declareDefeat(true);
        const receipt = yield* harness.nextReceipt;

        expect(receipt).toMatchObject({
          battleId,
          retired: [worktreePath],
          skippedShared: [],
          skippedDirty: [],
          skippedFailed: [],
        });
        expect(worktreeExists(harness.repositoryRoot, worktreePath)).toBe(false);
        // The branch survives retirement: that is what a reopen re-provisions from.
        expect(branchExists(harness.repositoryRoot, "battle-streaming-diff")).toBe(true);

        const snapshot = yield* harness.readModel;
        const thread = snapshot.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
        expect(thread?.worktreePath).toBeNull();
        expect(thread?.branch).toBe("battle-streaming-diff");
      }),
    ),
  );

  it.live("keeps a worktree that a thread outside the battle also uses", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const worktreePath = yield* harness.addWorktree("battle-shared");
        yield* harness.createBattle;
        yield* harness.createThread({
          threadId: "thread-1",
          worktreePath,
          branch: "battle-shared",
          battleId,
        });
        yield* harness.createThread({
          threadId: "thread-outsider",
          worktreePath,
          branch: "battle-shared",
          battleId: null,
        });

        yield* harness.declareDefeat(true);
        const receipt = yield* harness.nextReceipt;

        expect(receipt).toMatchObject({
          retired: [],
          skippedShared: [worktreePath],
        });
        expect(worktreeExists(harness.repositoryRoot, worktreePath)).toBe(true);

        const snapshot = yield* harness.readModel;
        const thread = snapshot.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
        expect(thread?.worktreePath).toBe(worktreePath);
      }),
    ),
  );

  it.live("counts an archived outsider thread as an occupant", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const worktreePath = yield* harness.addWorktree("battle-archived-share");
        yield* harness.createBattle;
        yield* harness.createThread({
          threadId: "thread-1",
          worktreePath,
          branch: "battle-archived-share",
          battleId,
        });
        yield* harness.createThread({
          threadId: "thread-archived-outsider",
          worktreePath,
          branch: "battle-archived-share",
          battleId: null,
          archived: true,
        });

        yield* harness.declareDefeat(true);
        const receipt = yield* harness.nextReceipt;

        expect(receipt).toMatchObject({
          retired: [],
          skippedShared: [worktreePath],
        });
        expect(worktreeExists(harness.repositoryRoot, worktreePath)).toBe(true);
      }),
    ),
  );

  it.live("keeps a worktree with uncommitted changes", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const worktreePath = yield* harness.addWorktree("battle-dirty");
        harness.markDirty(worktreePath);
        yield* harness.createBattle;
        yield* harness.createThread({
          threadId: "thread-1",
          worktreePath,
          branch: "battle-dirty",
          battleId,
        });

        yield* harness.declareDefeat(true);
        const receipt = yield* harness.nextReceipt;

        expect(receipt).toMatchObject({
          retired: [],
          skippedDirty: [worktreePath],
        });
        expect(worktreeExists(harness.repositoryRoot, worktreePath)).toBe(true);

        const snapshot = yield* harness.readModel;
        const thread = snapshot.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
        expect(thread?.worktreePath).toBe(worktreePath);
      }),
    ),
  );

  it.live("leaves every worktree alone when the user declined retirement", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const worktreePath = yield* harness.addWorktree("battle-kept");
        yield* harness.createBattle;
        yield* harness.createThread({
          threadId: "thread-1",
          worktreePath,
          branch: "battle-kept",
          battleId,
        });

        yield* harness.declareDefeat(false);
        const receipt = yield* harness.nextReceipt;

        expect(receipt).toMatchObject({
          retired: [],
          skippedShared: [],
          skippedDirty: [],
          skippedFailed: [],
        });
        expect(worktreeExists(harness.repositoryRoot, worktreePath)).toBe(true);

        const snapshot = yield* harness.readModel;
        const thread = snapshot.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
        expect(thread?.worktreePath).toBe(worktreePath);
      }),
    ),
  );

  it.live("never removes a project root that a battle thread uses directly", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        yield* harness.createBattle;
        // A local-mode member: worktreePath is null, so its resolved cwd is the
        // project root. That must never become a retirement candidate.
        yield* harness.createThread({
          threadId: "thread-1",
          worktreePath: null,
          branch: null,
          battleId,
        });

        yield* harness.declareDefeat(true);
        const receipt = yield* harness.nextReceipt;

        expect(receipt).toMatchObject({
          retired: [],
          skippedShared: [],
          skippedDirty: [],
          skippedFailed: [],
        });
        expect(NodeFS.existsSync(harness.repositoryRoot)).toBe(true);
      }),
    ),
  );
});
