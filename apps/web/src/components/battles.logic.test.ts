import { BattleId, ProjectId, type OrchestrationBattle } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildSidebarBattleRows,
  formatBattleWorktreeLine,
  formatRepoRootLabel,
  layoutBattleMembers,
  summarizeBattleWorktrees,
} from "./battles.logic";

function makeBattle(id: string, createdAt = "2026-04-01T00:00:00.000Z"): OrchestrationBattle {
  return {
    id: BattleId.make(id),
    projectId: ProjectId.make("project-1"),
    title: `Battle ${id}`,
    goal: null,
    slug: `battle-${id}`,
    phase: "scoping",
    victoryConditions: [],
    orchestratorThreadId: null,
    defeatedAt: null,
    createdAt,
    updatedAt: createdAt,
    deletedAt: null,
  };
}

describe("buildSidebarBattleRows", () => {
  it("returns plain thread rows when there are no battles", () => {
    const threads = [
      { id: "a", battleId: null },
      { id: "b", battleId: null },
    ];

    expect(buildSidebarBattleRows(threads, [])).toEqual([
      { kind: "thread", thread: threads[0] },
      { kind: "thread", thread: threads[1] },
    ]);
  });

  it("places a battle at its first member and keeps other threads in order", () => {
    const battle = makeBattle("battle-1");
    const threads = [
      { id: "a", battleId: null },
      { id: "b", battleId: battle.id },
      { id: "c", battleId: null },
      { id: "d", battleId: battle.id },
    ];

    const rows = buildSidebarBattleRows(threads, [battle]);

    expect(rows.map((row) => (row.kind === "battle" ? row.battle.id : row.thread.id))).toEqual([
      "a",
      "battle-1",
      "c",
    ]);
    expect(rows[1]).toMatchObject({
      kind: "battle",
      threads: [threads[1], threads[3]],
    });
  });

  it("trails a battle that has no member yet", () => {
    const battle = makeBattle("battle-1");

    const rows = buildSidebarBattleRows([{ id: "a", battleId: null }], [battle]);

    expect(rows).toEqual([
      { kind: "thread", thread: { id: "a", battleId: null } },
      { kind: "battle", battle, threads: [] },
    ]);
  });
});

describe("layoutBattleMembers", () => {
  const frontendA = {
    id: "a",
    branch: "battle/x",
    worktreePath: "/w/frontend/battle-x",
  };
  const backendB = { id: "b", branch: "battle/x", worktreePath: "/w/backend/battle-x" };
  const frontendC = {
    id: "c",
    branch: "battle/x",
    worktreePath: "/w/frontend/battle-x",
  };

  it("keeps a single-worktree battle as a plain member list", () => {
    expect(layoutBattleMembers([frontendA, frontendC])).toEqual([
      { kind: "thread", thread: frontendA },
      { kind: "thread", thread: frontendC },
    ]);
  });

  it("labels each worktree once the battle spans two repos", () => {
    const items = layoutBattleMembers([frontendA, backendB, frontendC]);

    expect(items.map((item) => (item.kind === "thread" ? item.thread.id : item.repoLabel))).toEqual(
      ["frontend", "a", "c", "backend", "b"],
    );
  });
});

describe("formatRepoRootLabel", () => {
  it("names the project root and nested repos", () => {
    expect(formatRepoRootLabel({ relativePath: "." })).toBe("Project root");
    expect(formatRepoRootLabel({ relativePath: "frontend" })).toBe("frontend");
    expect(formatRepoRootLabel({ relativePath: "services/api" })).toBe("services/api");
  });
});

describe("summarizeBattleWorktrees", () => {
  it("lists one line per worktree and counts local threads apart", () => {
    const summary = summarizeBattleWorktrees([
      {
        branch: "battle/streaming-diff",
        worktreePath: "/home/dev/.t3/worktrees/frontend/battle-streaming-diff",
      },
      {
        branch: "battle/streaming-diff",
        worktreePath: "/home/dev/.t3/worktrees/frontend/battle-streaming-diff",
      },
      {
        branch: "battle/streaming-diff",
        worktreePath: "/home/dev/.t3/worktrees/backend/battle-streaming-diff",
      },
      { branch: "main", worktreePath: null },
    ]);

    expect(summary.lines).toEqual([
      "frontend — battle/streaming-diff (2 threads)",
      "backend — battle/streaming-diff (1 thread)",
    ]);
    expect(summary.localThreadsLabel).toBe("1 thread running locally");
    expect(summary.branchCount).toBe(2);
  });

  it("names a detached worktree instead of dropping the line", () => {
    expect(
      formatBattleWorktreeLine({
        worktreePath: "/w/frontend/x",
        branch: null,
        repoLabel: "frontend",
        threads: [{}],
      }),
    ).toBe("frontend — detached (1 thread)");
  });
});
