import { describe, expect, it } from "vite-plus/test";

import {
  BattleId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  VictoryConditionId,
  battleLinesDrawn,
  type OrchestrationBattle,
  type OrchestrationSession,
  type OrchestrationThreadShell,
  type VictoryCondition,
  type VictoryConditionState,
} from "@t3tools/contracts";

import {
  aggregateBattleStatus,
  battleForThread,
  battleScopeProgress,
  battlesForProject,
  groupBattleThreadsByWorktree,
  partitionThreadsByBattle,
  resolveBattlePhase,
  resolveWorktreeMates,
} from "./battles.ts";

const PROJECT_ID = ProjectId.make("project-1");

function makeBattle({
  id,
  ...overrides
}: Omit<Partial<OrchestrationBattle>, "id"> & { id: string }): OrchestrationBattle {
  return {
    projectId: PROJECT_ID,
    title: `Battle ${id}`,
    goal: null,
    slug: `battle-${id}`,
    phase: "scoping",
    victoryConditions: [],
    defeatedAt: null,
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:00.000Z",
    deletedAt: null,
    ...overrides,
    id: BattleId.make(id),
  };
}

function makeCondition(state: VictoryConditionState, id = state): VictoryCondition {
  return {
    id: VictoryConditionId.make(`condition-${id}`),
    title: `Condition ${id}`,
    state,
    sizeScore: null,
    sizeProvisional: false,
    ownerThreadId: null,
    strikeReason: null,
    updatedByThreadId: null,
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:00.000Z",
  };
}

function makeThread({
  id,
  ...overrides
}: Omit<Partial<OrchestrationThreadShell>, "id"> & { id: string }): OrchestrationThreadShell {
  return {
    projectId: PROJECT_ID,
    title: `Thread ${id}`,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
    id: ThreadId.make(id),
  };
}

const SETTLED_TURN = {
  turnId: TurnId.make("turn-1"),
  state: "completed",
  requestedAt: "2026-04-01T00:00:00.000Z",
  startedAt: "2026-04-01T00:00:00.000Z",
  completedAt: "2026-04-01T00:01:00.000Z",
  assistantMessageId: null,
} as const;

function makeSession(status: OrchestrationSession["status"]): OrchestrationSession {
  return {
    threadId: ThreadId.make("thread-session"),
    status,
    providerName: null,
    runtimeMode: "full-access",
    activeTurnId: null,
    lastError: null,
    updatedAt: "2026-04-01T00:00:00.000Z",
  };
}

describe("battleForThread / battlesForProject", () => {
  const battle = makeBattle({ id: "battle-1" });
  const otherProjectBattle = makeBattle({
    id: "battle-2",
    projectId: ProjectId.make("project-2"),
  });
  const deletedBattle = makeBattle({ id: "battle-3", deletedAt: "2026-04-02T00:00:00.000Z" });
  const snapshot = { battles: [battle, otherProjectBattle, deletedBattle] };

  it("resolves a thread's battle and tolerates threads without one", () => {
    expect(battleForThread(snapshot, makeThread({ id: "t1", battleId: battle.id }))).toBe(battle);
    expect(battleForThread(snapshot, makeThread({ id: "t2" }))).toBe(null);
    expect(battleForThread(snapshot, null)).toBe(null);
  });

  it("lists a project's live battles", () => {
    expect(battlesForProject(snapshot, PROJECT_ID)).toEqual([battle]);
  });
});

describe("partitionThreadsByBattle", () => {
  const older = makeBattle({ id: "older", createdAt: "2026-04-01T00:00:00.000Z" });
  const newer = makeBattle({ id: "newer", createdAt: "2026-04-03T00:00:00.000Z" });

  it("keeps threads without a battle ungrouped, in input order", () => {
    const threads = [makeThread({ id: "a" }), makeThread({ id: "b" })];

    const { groups, standalone } = partitionThreadsByBattle(threads, []);

    expect(groups).toEqual([]);
    expect(standalone.map((thread) => thread.id)).toEqual(["a", "b"]);
  });

  it("groups members newest battle first and preserves member order", () => {
    const threads = [
      makeThread({ id: "a", battleId: older.id }),
      makeThread({ id: "b", battleId: newer.id }),
      makeThread({ id: "c", battleId: older.id }),
      makeThread({ id: "d" }),
    ];

    const { groups, standalone } = partitionThreadsByBattle(threads, [older, newer]);

    expect(groups.map((group) => group.battle.id)).toEqual(["newer", "older"]);
    expect(groups[0]?.threads.map((thread) => thread.id)).toEqual(["b"]);
    expect(groups[1]?.threads.map((thread) => thread.id)).toEqual(["a", "c"]);
    expect(standalone.map((thread) => thread.id)).toEqual(["d"]);
  });

  it("renders an empty battle and falls back to standalone for unknown battles", () => {
    const threads = [makeThread({ id: "a", battleId: BattleId.make("missing") })];

    const { groups, standalone } = partitionThreadsByBattle(threads, [newer]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.threads).toEqual([]);
    expect(standalone.map((thread) => thread.id)).toEqual(["a"]);
  });
});

describe("groupBattleThreadsByWorktree", () => {
  it("groups multi-repo members by worktree and keeps local threads apart", () => {
    const members = [
      makeThread({
        id: "fe-1",
        branch: "battle/streaming-diff",
        worktreePath: "/home/dev/.t3/worktrees/frontend/battle-streaming-diff",
      }),
      makeThread({
        id: "be-1",
        branch: "battle/streaming-diff",
        worktreePath: "/home/dev/.t3/worktrees/backend/battle-streaming-diff",
      }),
      makeThread({
        id: "fe-2",
        branch: "battle/streaming-diff",
        worktreePath: "/home/dev/.t3/worktrees/frontend/battle-streaming-diff",
      }),
      makeThread({ id: "local-1" }),
    ];

    const { worktrees, localThreads } = groupBattleThreadsByWorktree(members);

    expect(worktrees).toHaveLength(2);
    expect(worktrees[0]?.repoLabel).toBe("frontend");
    expect(worktrees[0]?.branch).toBe("battle/streaming-diff");
    expect(worktrees[0]?.threads.map((thread) => thread.id)).toEqual(["fe-1", "fe-2"]);
    expect(worktrees[1]?.repoLabel).toBe("backend");
    expect(worktrees[1]?.threads.map((thread) => thread.id)).toEqual(["be-1"]);
    expect(localThreads.map((thread) => thread.id)).toEqual(["local-1"]);
  });

  it("falls back to the leaf segment for paths outside the worktree layout", () => {
    const { worktrees } = groupBattleThreadsByWorktree([
      makeThread({ id: "a", worktreePath: "/checkout" }),
    ]);

    expect(worktrees[0]?.repoLabel).toBe("checkout");
  });
});

describe("resolveWorktreeMates", () => {
  const worktreePath = "/home/dev/.t3/worktrees/frontend/battle-streaming-diff";
  const thread = makeThread({ id: "a", worktreePath });
  const mate = makeThread({ id: "b", worktreePath });
  const archivedMate = makeThread({
    id: "c",
    worktreePath,
    archivedAt: "2026-04-02T00:00:00.000Z",
  });
  const elsewhere = makeThread({
    id: "d",
    worktreePath: "/home/dev/.t3/worktrees/backend/battle-streaming-diff",
  });
  const local = makeThread({ id: "e" });

  it("returns live threads sharing the worktree, excluding the thread itself", () => {
    const mates = resolveWorktreeMates([thread, mate, archivedMate, elsewhere, local], {
      id: thread.id,
      cwd: thread.worktreePath,
    });

    expect(mates.map((candidate) => candidate.id)).toEqual(["b"]);
  });

  it("pairs local threads only when the caller resolves them to a shared root", () => {
    const threads = [local, makeThread({ id: "f" })];

    expect(resolveWorktreeMates(threads, { id: local.id, cwd: local.worktreePath })).toEqual([]);
    expect(
      resolveWorktreeMates(
        threads,
        { id: local.id, cwd: "/repo" },
        (candidate) => candidate.worktreePath ?? "/repo",
      ).map((candidate) => candidate.id),
    ).toEqual(["f"]);
  });
});

describe("resolveBattlePhase and battleScopeProgress", () => {
  it("reports linesDrawn once every condition resolved with a survivor", () => {
    const battle = makeBattle({
      id: "battle-1",
      victoryConditions: [makeCondition("scoped"), makeCondition("descoped")],
    });

    expect(battleLinesDrawn(battle)).toBe(true);
    expect(resolveBattlePhase(battle)).toBe("linesDrawn");
    expect(battleScopeProgress(battle)).toEqual({ scoped: 1, total: 1 });
  });

  it("stays scoping while any condition is unresolved", () => {
    const battle = makeBattle({
      id: "battle-1",
      victoryConditions: [makeCondition("scoped"), makeCondition("scoping")],
    });

    expect(resolveBattlePhase(battle)).toBe("scoping");
    expect(battleScopeProgress(battle)).toEqual({ scoped: 1, total: 2 });
  });

  it("keeps a stored phase that outranks scoping", () => {
    const conditions = [makeCondition("scoped")];

    expect(resolveBattlePhase(makeBattle({ id: "b", phase: "fighting" }))).toBe("fighting");
    expect(
      resolveBattlePhase(makeBattle({ id: "b", phase: "defeated", victoryConditions: conditions })),
    ).toBe("defeated");
  });

  it("reports no progress for a battle without conditions", () => {
    const battle = makeBattle({ id: "battle-1" });

    expect(resolveBattlePhase(battle)).toBe("scoping");
    expect(battleScopeProgress(battle)).toEqual({ scoped: 0, total: 0 });
  });
});

describe("aggregateBattleStatus", () => {
  const working = makeThread({ id: "working", session: makeSession("running") });
  const awaitingInput = makeThread({ id: "awaiting", hasPendingUserInput: true });
  const pendingApproval = makeThread({ id: "approval", hasPendingApprovals: true });
  const planReady = makeThread({
    id: "plan",
    interactionMode: "plan",
    hasActionableProposedPlan: true,
    latestTurn: SETTLED_TURN,
  });
  const completed = {
    ...makeThread({ id: "completed", latestTurn: SETTLED_TURN }),
    lastVisitedAt: "2026-04-01T00:00:30.000Z",
  };

  it("returns null when no member has anything to report", () => {
    expect(aggregateBattleStatus([makeThread({ id: "idle" })])).toBe(null);
    expect(aggregateBattleStatus([])).toBe(null);
  });

  it("picks the highest priority member status", () => {
    expect(aggregateBattleStatus([completed, planReady])).toBe("plan-ready");
    expect(aggregateBattleStatus([completed, planReady, working])).toBe("working");
    expect(aggregateBattleStatus([working, awaitingInput])).toBe("awaiting-input");
    expect(aggregateBattleStatus([awaitingInput, pendingApproval, working])).toBe(
      "pending-approval",
    );
  });

  it("reads background liveness when the turn has settled", () => {
    expect(
      aggregateBattleStatus([makeThread({ id: "bg", backgroundLiveness: "working" }), completed]),
    ).toBe("working");
    expect(
      aggregateBattleStatus([
        makeThread({ id: "bg", backgroundLiveness: "monitoring" }),
        completed,
      ]),
    ).toBe("monitoring");
  });
});
