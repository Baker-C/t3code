import type {
  BattleId,
  BattleQueueEntry,
  OrchestrationBattle,
  OrchestrationCommand,
  OrchestrationProject,
  OrchestrationReadModel,
  OrchestrationThread,
  ProjectId,
  QueueAction,
  QueueActionId,
  ThreadId,
  VictoryCondition,
  VictoryConditionId,
} from "@t3tools/contracts";
import { resolveQueueEntries } from "@t3tools/contracts";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import * as Effect from "effect/Effect";

import { OrchestrationCommandInvariantError } from "./Errors.ts";

function invariantError(commandType: string, detail: string): OrchestrationCommandInvariantError {
  return new OrchestrationCommandInvariantError({
    commandType,
    detail,
  });
}

export function findThreadById(
  readModel: OrchestrationReadModel,
  threadId: ThreadId,
): OrchestrationThread | undefined {
  return readModel.threads.find((thread) => thread.id === threadId);
}

export function findProjectById(
  readModel: OrchestrationReadModel,
  projectId: ProjectId,
): OrchestrationProject | undefined {
  return readModel.projects.find((project) => project.id === projectId);
}

export function listThreadsByProjectId(
  readModel: OrchestrationReadModel,
  projectId: ProjectId,
): ReadonlyArray<OrchestrationThread> {
  return readModel.threads.filter((thread) => thread.projectId === projectId);
}

export function findBattleById(
  readModel: OrchestrationReadModel,
  battleId: BattleId,
): OrchestrationBattle | undefined {
  return readModel.battles.find((battle) => battle.id === battleId);
}

export function listThreadsByBattleId(
  readModel: OrchestrationReadModel,
  battleId: BattleId,
): ReadonlyArray<OrchestrationThread> {
  return readModel.threads.filter((thread) => thread.battleId === battleId);
}

/**
 * A battle that exists and has not been deleted. Deleted battles stay in the
 * read model as tombstones, so every battle command checks both.
 */
export function requireBattle(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly battleId: BattleId;
}): Effect.Effect<OrchestrationBattle, OrchestrationCommandInvariantError> {
  const battle = findBattleById(input.readModel, input.battleId);
  if (battle && battle.deletedAt === null) {
    return Effect.succeed(battle);
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Battle '${input.battleId}' does not exist for command '${input.command.type}'.`,
    ),
  );
}

export function requireBattleAbsent(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly battleId: BattleId;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  if (!findBattleById(input.readModel, input.battleId)) {
    return Effect.void;
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Battle '${input.battleId}' already exists and cannot be created twice.`,
    ),
  );
}

/** A defeated battle is closed for scope edits until it is reopened. */
export function requireBattleNotDefeated(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly battleId: BattleId;
}): Effect.Effect<OrchestrationBattle, OrchestrationCommandInvariantError> {
  return requireBattle(input).pipe(
    Effect.flatMap((battle) =>
      battle.phase === "defeated"
        ? Effect.fail(
            invariantError(
              input.command.type,
              `Battle '${input.battleId}' is defeated and cannot handle command '${input.command.type}'.`,
            ),
          )
        : Effect.succeed(battle),
    ),
  );
}

export function findQueueEntryByBattleId(
  readModel: OrchestrationReadModel,
  battleId: BattleId,
): BattleQueueEntry | undefined {
  return resolveQueueEntries(readModel.queueEntries).find((entry) => entry.battleId === battleId);
}

/** A battle that is currently in the queue. */
export function requireQueueEntry(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly battleId: BattleId;
}): Effect.Effect<BattleQueueEntry, OrchestrationCommandInvariantError> {
  const entry = findQueueEntryByBattleId(input.readModel, input.battleId);
  if (entry) {
    return Effect.succeed(entry);
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Battle '${input.battleId}' is not in the queue for command '${input.command.type}'.`,
    ),
  );
}

/**
 * Adding a battle already in the queue is refused rather than treated as a
 * no-op: silently succeeding would let a double click reset the priority the
 * first click set.
 */
export function requireQueueEntryAbsent(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly battleId: BattleId;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  if (!findQueueEntryByBattleId(input.readModel, input.battleId)) {
    return Effect.void;
  }
  return Effect.fail(
    invariantError(input.command.type, `Battle '${input.battleId}' is already in the queue.`),
  );
}

export function requireQueueAction(input: {
  readonly command: OrchestrationCommand;
  readonly entry: BattleQueueEntry;
  readonly actionId: QueueActionId;
}): Effect.Effect<QueueAction, OrchestrationCommandInvariantError> {
  const action = input.entry.actions.find((candidate) => candidate.id === input.actionId);
  if (action) {
    return Effect.succeed(action);
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Action '${input.actionId}' does not exist on queued battle '${input.entry.battleId}'.`,
    ),
  );
}

/**
 * A thread partition has to be a partition: every named thread must be a live
 * member of the battle, and no thread may sit in two groups. A malformed
 * grouping would make one turn open two actions, so it is refused rather than
 * normalized — both authors can send a correct list.
 */
export function requireBattleThreadGroupsValid(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly battleId: BattleId;
  readonly groups: ReadonlyArray<{ readonly threadIds: ReadonlyArray<ThreadId> }>;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  const members = new Set(
    listThreadsByBattleId(input.readModel, input.battleId)
      .filter((thread) => thread.deletedAt === null)
      .map((thread) => thread.id),
  );
  const seen = new Set<ThreadId>();
  for (const group of input.groups) {
    for (const threadId of group.threadIds) {
      if (!members.has(threadId)) {
        return Effect.fail(
          invariantError(
            input.command.type,
            `Thread '${threadId}' is not a live member of battle '${input.battleId}' and cannot be grouped in it.`,
          ),
        );
      }
      if (seen.has(threadId)) {
        return Effect.fail(
          invariantError(
            input.command.type,
            `Thread '${threadId}' appears in more than one group of battle '${input.battleId}'.`,
          ),
        );
      }
      seen.add(threadId);
    }
  }
  return Effect.void;
}

export function requireBattleCondition(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly battle: OrchestrationBattle;
  readonly conditionId: VictoryConditionId;
}): Effect.Effect<VictoryCondition, OrchestrationCommandInvariantError> {
  const condition = input.battle.victoryConditions.find(
    (candidate) => candidate.id === input.conditionId,
  );
  if (condition) {
    return Effect.succeed(condition);
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Victory condition '${input.conditionId}' does not exist on battle '${input.battle.id}'.`,
    ),
  );
}

export function requireBattleConditionAbsent(input: {
  readonly command: OrchestrationCommand;
  readonly battle: OrchestrationBattle;
  readonly conditionId: VictoryConditionId;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  if (!input.battle.victoryConditions.some((candidate) => candidate.id === input.conditionId)) {
    return Effect.void;
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Victory condition '${input.conditionId}' already exists on battle '${input.battle.id}'.`,
    ),
  );
}

export function requireProject(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly projectId: ProjectId;
}): Effect.Effect<OrchestrationProject, OrchestrationCommandInvariantError> {
  const project = findProjectById(input.readModel, input.projectId);
  if (project) {
    return Effect.succeed(project);
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Project '${input.projectId}' does not exist for command '${input.command.type}'.`,
    ),
  );
}

export function requireProjectAbsent(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly projectId: ProjectId;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  if (!findProjectById(input.readModel, input.projectId)) {
    return Effect.void;
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Project '${input.projectId}' already exists and cannot be created twice.`,
    ),
  );
}

export function requireActiveProjectWorkspaceRootAbsent(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly workspaceRoot: string;
  readonly exceptProjectId?: ProjectId;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  const normalizedWorkspaceRoot = normalizeProjectPathForComparison(input.workspaceRoot);
  const existingProject = input.readModel.projects.find(
    (project) =>
      project.deletedAt === null &&
      normalizeProjectPathForComparison(project.workspaceRoot) === normalizedWorkspaceRoot &&
      project.id !== input.exceptProjectId,
  );
  if (existingProject === undefined) {
    return Effect.void;
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Active project '${existingProject.id}' already exists for workspace root '${normalizedWorkspaceRoot}'.`,
    ),
  );
}

export function requireThread(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly threadId: ThreadId;
}): Effect.Effect<OrchestrationThread, OrchestrationCommandInvariantError> {
  const thread = findThreadById(input.readModel, input.threadId);
  if (thread) {
    return Effect.succeed(thread);
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Thread '${input.threadId}' does not exist for command '${input.command.type}'.`,
    ),
  );
}

export function requireThreadArchived(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly threadId: ThreadId;
}): Effect.Effect<OrchestrationThread, OrchestrationCommandInvariantError> {
  return requireThread(input).pipe(
    Effect.flatMap((thread) =>
      thread.archivedAt !== null
        ? Effect.succeed(thread)
        : Effect.fail(
            invariantError(
              input.command.type,
              `Thread '${input.threadId}' is not archived for command '${input.command.type}'.`,
            ),
          ),
    ),
  );
}

export function requireThreadNotArchived(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly threadId: ThreadId;
}): Effect.Effect<OrchestrationThread, OrchestrationCommandInvariantError> {
  return requireThread(input).pipe(
    Effect.flatMap((thread) =>
      thread.archivedAt === null
        ? Effect.succeed(thread)
        : Effect.fail(
            invariantError(
              input.command.type,
              `Thread '${input.threadId}' is already archived and cannot handle command '${input.command.type}'.`,
            ),
          ),
    ),
  );
}

export function requireThreadAbsent(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly threadId: ThreadId;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  if (!findThreadById(input.readModel, input.threadId)) {
    return Effect.void;
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Thread '${input.threadId}' already exists and cannot be created twice.`,
    ),
  );
}

export function requireNonNegativeInteger(input: {
  readonly commandType: OrchestrationCommand["type"];
  readonly field: string;
  readonly value: number;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  if (Number.isInteger(input.value) && input.value >= 0) {
    return Effect.void;
  }
  return Effect.fail(
    invariantError(
      input.commandType,
      `${input.field} must be an integer greater than or equal to 0.`,
    ),
  );
}
