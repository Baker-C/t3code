import {
  battleLinesDrawn,
  type BattleId,
  type OrchestrationBattle,
  type OrchestrationShellSnapshot,
  type OrchestrationThreadShell,
  type ProjectId,
} from "@t3tools/contracts";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";

/** Battle membership as it appears on any client's thread shape. */
export interface BattleMemberThread {
  readonly battleId?: BattleId | null | undefined;
}

export interface BattleGroup<T, B extends OrchestrationBattle = OrchestrationBattle> {
  readonly battle: B;
  readonly threads: readonly T[];
}

export function battleForThread(
  snapshot: Pick<OrchestrationShellSnapshot, "battles">,
  thread: BattleMemberThread | null | undefined,
): OrchestrationBattle | null {
  const battleId = thread?.battleId;
  if (battleId == null) return null;
  return snapshot.battles.find((battle) => battle.id === battleId) ?? null;
}

export function battlesForProject(
  snapshot: Pick<OrchestrationShellSnapshot, "battles">,
  projectId: ProjectId,
): OrchestrationBattle[] {
  return snapshot.battles.filter(
    (battle) => battle.projectId === projectId && battle.deletedAt === null,
  );
}

function battleCreationTime(battle: OrchestrationBattle): number {
  const parsed = Date.parse(battle.createdAt);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * Splits an already-ordered thread list into battle groups plus the threads
 * that belong to no battle. Standalone threads keep their input order and
 * render exactly as they did before battles existed; a thread whose battle is
 * missing from `battles` (a projection race, or a battle filtered out by the
 * caller) falls back to standalone rather than disappearing.
 *
 * Groups sort newest battle first to match the sidebar's creation order, and
 * every given battle gets a group so a battle with no thread yet still renders.
 */
export function partitionThreadsByBattle<
  T extends BattleMemberThread,
  B extends OrchestrationBattle,
>(threads: readonly T[], battles: readonly B[]): { groups: BattleGroup<T, B>[]; standalone: T[] } {
  const membersByBattleId = new Map<BattleId, T[]>();
  const standalone: T[] = [];
  const knownBattleIds = new Set(battles.map((battle) => battle.id));
  for (const thread of threads) {
    const battleId = thread.battleId;
    if (battleId == null || !knownBattleIds.has(battleId)) {
      standalone.push(thread);
      continue;
    }
    const existing = membersByBattleId.get(battleId);
    if (existing) {
      existing.push(thread);
    } else {
      membersByBattleId.set(battleId, [thread]);
    }
  }

  const groups = [...battles]
    .sort(
      (left, right) =>
        battleCreationTime(right) - battleCreationTime(left) || right.id.localeCompare(left.id),
    )
    .map((battle) => ({ battle, threads: membersByBattleId.get(battle.id) ?? [] }));

  return { groups, standalone };
}

/** Thread fields every worktree grouping and mate lookup reads. */
export interface WorktreeThread {
  readonly branch: string | null;
  readonly worktreePath: string | null;
}

export interface BattleWorktreeGroup<T> {
  readonly worktreePath: string;
  readonly branch: string | null;
  readonly repoLabel: string;
  readonly threads: readonly T[];
}

/**
 * Worktrees are created at `<worktrees dir>/<repo name>/<branch>`, so the
 * segment before the leaf names the repository — the label that tells a
 * frontend worktree from a backend one inside the same project folder. Paths
 * that do not follow the layout fall back to their leaf segment.
 */
export function deriveWorktreeRepoLabel(worktreePath: string): string {
  const segments = worktreePath
    .split(/[/\\]/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
  return segments.at(-2) ?? segments.at(-1) ?? worktreePath;
}

/**
 * Groups a battle's member threads by the worktree they run in — the unit
 * turns serialize on. Threads in local mode carry no worktree and come back
 * in `localThreads`. Groups and their threads keep the input order.
 */
export function groupBattleThreadsByWorktree<T extends WorktreeThread>(
  members: readonly T[],
): { worktrees: BattleWorktreeGroup<T>[]; localThreads: T[] } {
  const groupsByKey = new Map<string, { group: BattleWorktreeGroup<T>; threads: T[] }>();
  const worktrees: BattleWorktreeGroup<T>[] = [];
  const localThreads: T[] = [];
  for (const thread of members) {
    const worktreePath = thread.worktreePath;
    if (worktreePath === null) {
      localThreads.push(thread);
      continue;
    }
    const key = normalizeProjectPathForComparison(worktreePath);
    const existing = groupsByKey.get(key);
    if (existing) {
      existing.threads.push(thread);
      continue;
    }
    const threads: T[] = [thread];
    const group: BattleWorktreeGroup<T> = {
      worktreePath,
      branch: thread.branch,
      repoLabel: deriveWorktreeRepoLabel(worktreePath),
      threads,
    };
    groupsByKey.set(key, { group, threads });
    worktrees.push(group);
  }
  return { worktrees, localThreads };
}

export interface WorktreeMateThread extends WorktreeThread {
  readonly id: string;
  readonly archivedAt: string | null;
}

/**
 * The other live threads sharing this thread's working directory — the
 * threads whose turns serialize against it. The target passes its own
 * resolved `cwd`, and `resolveCwd` widens the candidates the same way, so a
 * caller that treats local threads as sharing the project root can say so;
 * by default only worktree-bound threads pair up.
 */
export function resolveWorktreeMates<T extends WorktreeMateThread>(
  threads: readonly T[],
  thread: { readonly id: string; readonly cwd: string | null },
  resolveCwd: (candidate: T) => string | null = (candidate) => candidate.worktreePath,
): T[] {
  const cwd = thread.cwd;
  if (cwd === null) return [];
  const key = normalizeProjectPathForComparison(cwd);
  if (key.length === 0) return [];
  return threads.filter((candidate) => {
    if (candidate.id === thread.id || candidate.archivedAt !== null) return false;
    const candidateCwd = resolveCwd(candidate);
    return candidateCwd !== null && normalizeProjectPathForComparison(candidateCwd) === key;
  });
}

/**
 * The stored phase widened with "linesDrawn": every condition resolved and at
 * least one survived, so the battle is fully planned but not yet fighting.
 */
export type ResolvedBattlePhase = "scoping" | "linesDrawn" | "fighting" | "defeated";

export function resolveBattlePhase(
  battle: Pick<OrchestrationBattle, "phase" | "victoryConditions">,
): ResolvedBattlePhase {
  if (battle.phase !== "scoping") return battle.phase;
  return battleLinesDrawn(battle) ? "linesDrawn" : "scoping";
}

/** Scoping progress, counting a condition as met once its plan is pinned.
    Struck conditions leave the denominator instead of counting against it. */
export function battleScopeProgress(battle: Pick<OrchestrationBattle, "victoryConditions">): {
  scoped: number;
  total: number;
} {
  let scoped = 0;
  let total = 0;
  for (const condition of battle.victoryConditions) {
    if (condition.state === "descoped") continue;
    total += 1;
    if (condition.state === "scoped") scoped += 1;
  }
  return { scoped, total };
}

export type BattleAggregateStatus =
  | "pending-approval"
  | "awaiting-input"
  | "working"
  | "plan-ready"
  | "monitoring"
  | "completed";

export type BattleStatusThread = Pick<
  OrchestrationThreadShell,
  | "hasActionableProposedPlan"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "interactionMode"
  | "latestTurn"
  | "session"
> &
  Partial<Pick<OrchestrationThreadShell, "backgroundLiveness">> & {
    readonly lastVisitedAt?: string | null | undefined;
  };

const BATTLE_STATUS_PRIORITY: Record<BattleAggregateStatus, number> = {
  "pending-approval": 6,
  "awaiting-input": 5,
  working: 4,
  "plan-ready": 3,
  monitoring: 2,
  completed: 1,
};

function hasUnseenCompletion(thread: BattleStatusThread): boolean {
  const completedAt = thread.latestTurn?.completedAt;
  if (!completedAt) return false;
  const completedAtMs = Date.parse(completedAt);
  if (Number.isNaN(completedAtMs)) return false;
  if (!thread.lastVisitedAt) return false;
  const lastVisitedAtMs = Date.parse(thread.lastVisitedAt);
  if (Number.isNaN(lastVisitedAtMs)) return true;
  return completedAtMs > lastVisitedAtMs;
}

function resolveBattleThreadStatus(thread: BattleStatusThread): BattleAggregateStatus | null {
  if (thread.hasPendingApprovals) return "pending-approval";
  if (thread.hasPendingUserInput) return "awaiting-input";
  if (thread.session?.status === "running" || thread.session?.status === "starting") {
    return "working";
  }
  const turnSettled = thread.latestTurn?.startedAt != null && thread.latestTurn.completedAt != null;
  if (thread.interactionMode === "plan" && turnSettled && thread.hasActionableProposedPlan) {
    return "plan-ready";
  }
  if (thread.backgroundLiveness === "working") return "working";
  if (thread.backgroundLiveness === "monitoring") return "monitoring";
  return hasUnseenCompletion(thread) ? "completed" : null;
}

/**
 * The status a battle row shows: the most demanding status among its member
 * threads, following the same priority the sidebar uses per thread. Null when
 * no member has anything to report.
 */
export function aggregateBattleStatus(
  memberThreads: readonly BattleStatusThread[],
): BattleAggregateStatus | null {
  let highest: BattleAggregateStatus | null = null;
  for (const thread of memberThreads) {
    const status = resolveBattleThreadStatus(thread);
    if (status === null) continue;
    if (highest === null || BATTLE_STATUS_PRIORITY[status] > BATTLE_STATUS_PRIORITY[highest]) {
      highest = status;
    }
  }
  return highest;
}
