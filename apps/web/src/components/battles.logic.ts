import {
  groupBattleThreadsByWorktree,
  partitionThreadsByBattle,
  type BattleMemberThread,
  type BattleWorktreeGroup,
} from "@t3tools/client-runtime/state/battles";
import type { OrchestrationBattle } from "@t3tools/contracts";

export type SidebarBattleRow<T, B extends OrchestrationBattle = OrchestrationBattle> =
  | { readonly kind: "battle"; readonly battle: B; readonly threads: readonly T[] }
  | { readonly kind: "thread"; readonly thread: T };

/**
 * Lays an already-sorted thread list out with its battles: each battle takes
 * the position of its first member, so grouping never reshuffles the sidebar's
 * static order, and threads outside a battle render exactly as before. A
 * battle with no member yet (freshly created) trails the list so it is still
 * reachable.
 */
export function buildSidebarBattleRows<T extends BattleMemberThread, B extends OrchestrationBattle>(
  threads: readonly T[],
  battles: readonly B[],
): SidebarBattleRow<T, B>[] {
  if (battles.length === 0) {
    return threads.map((thread) => ({ kind: "thread", thread }));
  }
  const { groups } = partitionThreadsByBattle(threads, battles);
  const groupByBattleId = new Map(groups.map((group) => [group.battle.id, group] as const));
  const rows: SidebarBattleRow<T, B>[] = [];
  const emitted = new Set<string>();
  for (const thread of threads) {
    const group = thread.battleId == null ? undefined : groupByBattleId.get(thread.battleId);
    if (group === undefined) {
      rows.push({ kind: "thread", thread });
      continue;
    }
    if (emitted.has(group.battle.id)) continue;
    emitted.add(group.battle.id);
    rows.push({ kind: "battle", battle: group.battle, threads: group.threads });
  }
  for (const group of groups) {
    if (emitted.has(group.battle.id)) continue;
    rows.push({ kind: "battle", battle: group.battle, threads: group.threads });
  }
  return rows;
}

export type BattleMemberLayoutItem<T> =
  | {
      readonly kind: "worktree-label";
      readonly worktreePath: string;
      readonly repoLabel: string;
      readonly branch: string | null;
    }
  | { readonly kind: "thread"; readonly thread: T };

/**
 * Member rows for one battle. A battle confined to a single worktree (or to
 * local threads) renders as a plain list, exactly like any other thread run.
 * Once it spans two or more worktrees the members regroup under a label per
 * worktree, because otherwise two rows on different repos read as one
 * workspace.
 */
export function layoutBattleMembers<
  T extends { readonly branch: string | null; readonly worktreePath: string | null },
>(members: readonly T[]): BattleMemberLayoutItem<T>[] {
  const { worktrees, localThreads } = groupBattleThreadsByWorktree(members);
  if (worktrees.length < 2) {
    return members.map((thread) => ({ kind: "thread", thread }));
  }
  const items: BattleMemberLayoutItem<T>[] = [];
  for (const group of worktrees) {
    items.push({
      kind: "worktree-label",
      worktreePath: group.worktreePath,
      repoLabel: group.repoLabel,
      branch: group.branch,
    });
    for (const thread of group.threads) {
      items.push({ kind: "thread", thread });
    }
  }
  for (const thread of localThreads) {
    items.push({ kind: "thread", thread });
  }
  return items;
}

function threadCountLabel(count: number): string {
  return count === 1 ? "1 thread" : `${count} threads`;
}

/** One worktree line for the battle menu and the declare-defeat dialog:
    "frontend — battle/streaming-diff (2 threads)". */
export function formatBattleWorktreeLine<T>(group: BattleWorktreeGroup<T>): string {
  const branch = group.branch ?? "detached";
  return `${group.repoLabel} — ${branch} (${threadCountLabel(group.threads.length)})`;
}

/** Repo-root label for the new-worktree picker: the folder inside the project
    that holds the repo, or the project itself when it is the repo. */
export function formatRepoRootLabel(root: { readonly relativePath: string }): string {
  const relativePath = root.relativePath.trim();
  return relativePath === "." || relativePath.length === 0 ? "Project root" : relativePath;
}

export interface BattleWorktreeSummary {
  readonly lines: ReadonlyArray<string>;
  readonly localThreadsLabel: string | null;
  readonly branchCount: number;
}

/** The battle's worktrees as the menu and the defeat dialog show them. */
export function summarizeBattleWorktrees<
  T extends { readonly branch: string | null; readonly worktreePath: string | null },
>(members: readonly T[]): BattleWorktreeSummary {
  const { worktrees, localThreads } = groupBattleThreadsByWorktree(members);
  return {
    lines: worktrees.map(formatBattleWorktreeLine),
    localThreadsLabel:
      localThreads.length === 0 ? null : `${threadCountLabel(localThreads.length)} running locally`,
    branchCount: worktrees.length,
  };
}
