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
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { afterEach, describe, expect, it } from "vite-plus/test";

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

/**
 * The reactor consumes domain events through a stream fiber, so `drain` alone
 * can return before the event is even enqueued. Every defeat settles with
 * exactly one receipt, so waiting for it is the precise milestone.
 */
async function waitForReceipt(
  receipts: ReadonlyArray<BattleWorktreeRetirementSettledReceipt>,
  maxAttempts = 1_500,
): Promise<BattleWorktreeRetirementSettledReceipt> {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const receipt = receipts[0];
    if (receipt) {
      return receipt;
    }
    await Effect.runPromise(Effect.sleep("10 millis"));
  }
  throw new Error("Timed out waiting for a battle retirement receipt.");
}

describe("BattleRetirementReactor", () => {
  let runtime: ManagedRuntime.ManagedRuntime<
    | OrchestrationEngineService
    | BattleRetirementReactor
    | ProjectionSnapshotQuery
    | RuntimeReceiptBus,
    unknown
  > | null = null;
  let scope: Scope.Closeable | null = null;
  const tempDirs: string[] = [];

  afterEach(async () => {
    if (scope) {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
    scope = null;
    if (runtime) {
      await runtime.dispose();
    }
    runtime = null;
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        NodeFS.rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  async function createHarness() {
    const repositoryRoot = createGitRepository();
    tempDirs.push(repositoryRoot);

    // Filled in by `markDirty` after a worktree path exists; the stub reads it
    // at call time so tests can set it up after the harness is built.
    const dirtyPaths = new Set<string>();

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

    // Only the dirty/clean decision is stubbed; the worktree removal itself
    // runs against the real repository.
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

    const layer = BattleRetirementReactorLive.pipe(
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

    runtime = ManagedRuntime.make(layer);
    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const snapshotQuery = await runtime.runPromise(Effect.service(ProjectionSnapshotQuery));
    const reactor = await runtime.runPromise(Effect.service(BattleRetirementReactor));
    const receiptBus = await runtime.runPromise(Effect.service(RuntimeReceiptBus));

    scope = await Effect.runPromise(Scope.make("sequential"));

    // Subscribe before anything can publish, so no receipt is missed. The
    // collector is forked into the harness scope rather than the calling
    // fiber, which would interrupt it the moment `runPromise` resolves.
    const receipts: Array<BattleWorktreeRetirementSettledReceipt> = [];
    const receiptFiber = await Effect.runPromise(
      Stream.runForEach(receiptBus.streamEventsForTest, (receipt) =>
        Effect.sync(() => {
          if (receipt.type === "battle.worktree-retirement.settled") {
            receipts.push(receipt);
          }
        }),
      ).pipe(Effect.forkScoped, Scope.provide(scope)),
    );

    await Effect.runPromise(reactor.start().pipe(Scope.provide(scope)));

    await Effect.runPromise(
      engine.dispatch({
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
      }),
    );

    const createThread = (input: {
      readonly threadId: string;
      readonly worktreePath: string | null;
      readonly branch: string | null;
      readonly battleId: BattleId | null;
      readonly archived?: boolean;
    }) =>
      Effect.runPromise(
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
          ),
      );

    const createBattle = async () => {
      await Effect.runPromise(
        engine.dispatch({
          type: "battle.create",
          commandId: CommandId.make("cmd-battle-create"),
          battleId,
          projectId,
          title: "Streaming diff",
          createdAt,
        }),
      );
      // battle.declare-fighting is guarded by battleLinesDrawn, so the battle
      // needs at least one scoped condition before it can be defeated.
      await Effect.runPromise(
        engine.dispatch({
          type: "battle.condition.add",
          commandId: CommandId.make("cmd-battle-condition-add"),
          battleId,
          conditionId: VictoryConditionId.make("condition-1"),
          title: "Ship it",
          state: "scoped",
        }),
      );
      await Effect.runPromise(
        engine.dispatch({
          type: "battle.declare-fighting",
          commandId: CommandId.make("cmd-battle-declare-fighting"),
          battleId,
        }),
      );
    };

    const declareDefeat = (retireWorktrees: boolean) =>
      Effect.runPromise(
        engine.dispatch({
          type: "battle.declare-defeat",
          commandId: CommandId.make("cmd-battle-declare-defeat"),
          battleId,
          retireWorktrees,
        }),
      );

    return {
      engine,
      repositoryRoot,
      createThread,
      createBattle,
      declareDefeat,
      receipts,
      drain: () => Effect.runPromise(reactor.drain),
      stopReceipts: () => Effect.runPromise(Fiber.interrupt(receiptFiber)),
      markDirty: (worktreePath: string) => {
        dirtyPaths.add(worktreePath.replaceAll("\\", "/"));
      },
      readModel: () => Effect.runPromise(snapshotQuery.getSnapshot()),
      addWorktree: (branch: string) => {
        const path = addWorktree(repositoryRoot, branch);
        tempDirs.push(path);
        return path;
      },
    };
  }

  it("removes an exclusively owned clean worktree and clears it from its threads", async () => {
    const harness = await createHarness();
    const worktreePath = harness.addWorktree("battle-streaming-diff");
    await harness.createBattle();
    await harness.createThread({
      threadId: "thread-1",
      worktreePath,
      branch: "battle-streaming-diff",
      battleId,
    });

    await harness.declareDefeat(true);
    const receipt = await waitForReceipt(harness.receipts);
    await harness.stopReceipts();

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

    const snapshot = await harness.readModel();
    const thread = snapshot.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.worktreePath).toBeNull();
    expect(thread?.branch).toBe("battle-streaming-diff");
  });

  it("keeps a worktree that a thread outside the battle also uses", async () => {
    const harness = await createHarness();
    const worktreePath = harness.addWorktree("battle-shared");
    await harness.createBattle();
    await harness.createThread({
      threadId: "thread-1",
      worktreePath,
      branch: "battle-shared",
      battleId,
    });
    await harness.createThread({
      threadId: "thread-outsider",
      worktreePath,
      branch: "battle-shared",
      battleId: null,
    });

    await harness.declareDefeat(true);
    const receipt = await waitForReceipt(harness.receipts);
    await harness.stopReceipts();

    expect(receipt).toMatchObject({
      retired: [],
      skippedShared: [worktreePath],
    });
    expect(worktreeExists(harness.repositoryRoot, worktreePath)).toBe(true);

    const snapshot = await harness.readModel();
    const thread = snapshot.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.worktreePath).toBe(worktreePath);
  });

  it("counts an archived outsider thread as an occupant", async () => {
    const harness = await createHarness();
    const worktreePath = harness.addWorktree("battle-archived-share");
    await harness.createBattle();
    await harness.createThread({
      threadId: "thread-1",
      worktreePath,
      branch: "battle-archived-share",
      battleId,
    });
    await harness.createThread({
      threadId: "thread-archived-outsider",
      worktreePath,
      branch: "battle-archived-share",
      battleId: null,
      archived: true,
    });

    await harness.declareDefeat(true);
    const receipt = await waitForReceipt(harness.receipts);
    await harness.stopReceipts();

    expect(receipt).toMatchObject({
      retired: [],
      skippedShared: [worktreePath],
    });
    expect(worktreeExists(harness.repositoryRoot, worktreePath)).toBe(true);
  });

  it("keeps a worktree with uncommitted changes", async () => {
    const harness = await createHarness();
    const worktreePath = harness.addWorktree("battle-dirty");
    harness.markDirty(worktreePath);
    await harness.createBattle();
    await harness.createThread({
      threadId: "thread-1",
      worktreePath,
      branch: "battle-dirty",
      battleId,
    });

    await harness.declareDefeat(true);
    const receipt = await waitForReceipt(harness.receipts);
    await harness.stopReceipts();

    expect(receipt).toMatchObject({
      retired: [],
      skippedDirty: [worktreePath],
    });
    expect(worktreeExists(harness.repositoryRoot, worktreePath)).toBe(true);

    const snapshot = await harness.readModel();
    const thread = snapshot.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.worktreePath).toBe(worktreePath);
  });

  it("leaves every worktree alone when the user declined retirement", async () => {
    const harness = await createHarness();
    const worktreePath = harness.addWorktree("battle-kept");
    await harness.createBattle();
    await harness.createThread({
      threadId: "thread-1",
      worktreePath,
      branch: "battle-kept",
      battleId,
    });

    await harness.declareDefeat(false);
    const receipt = await waitForReceipt(harness.receipts);
    await harness.stopReceipts();

    expect(receipt).toMatchObject({
      retired: [],
      skippedShared: [],
      skippedDirty: [],
      skippedFailed: [],
    });
    expect(worktreeExists(harness.repositoryRoot, worktreePath)).toBe(true);

    const snapshot = await harness.readModel();
    const thread = snapshot.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.worktreePath).toBe(worktreePath);
  });

  it("never removes a project root that a battle thread uses directly", async () => {
    const harness = await createHarness();
    await harness.createBattle();
    // A local-mode member: worktreePath is null, so its resolved cwd is the
    // project root. That must never become a retirement candidate.
    await harness.createThread({
      threadId: "thread-1",
      worktreePath: null,
      branch: null,
      battleId,
    });

    await harness.declareDefeat(true);
    const receipt = await waitForReceipt(harness.receipts);
    await harness.stopReceipts();

    expect(receipt).toMatchObject({
      retired: [],
      skippedShared: [],
      skippedDirty: [],
      skippedFailed: [],
    });
    expect(NodeFS.existsSync(harness.repositoryRoot)).toBe(true);
  });
});
