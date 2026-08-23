import {
  battleLinesDrawn,
  CommandId,
  type BattleId,
  type OrchestrationBattle,
  type OrchestrationCommand,
  type OrchestrationThreadShell,
  type ThreadId,
  VictoryConditionId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { BattleToolError, BattleToolkit, type BattleStatusResult } from "./tools.ts";

const readFailed = (operation: string, cause: unknown) =>
  Effect.logWarning("Battle tool could not read the current battle state.", {
    cause,
    operation,
  }).pipe(
    Effect.andThen(
      new BattleToolError({
        reason: "read-failed",
        detail: "Could not read the current battle state.",
      }),
    ),
  );

/**
 * Resolves the battle the calling thread fights in.
 *
 * The capability check is the security boundary; resolving the battle from the
 * caller's own thread is what makes the tools safe to expose without a battle
 * argument — an agent can only ever touch its own battle, so an id planted in
 * a prompt cannot redirect it.
 */
const requireBattleScope = Effect.fn("BattleToolkit.requireBattleScope")(function* () {
  const invocation = yield* McpInvocationContext.McpInvocationContext;
  if (!invocation.capabilities.has("battle")) {
    return yield* new BattleToolError({
      reason: "capability-unavailable",
      detail:
        "This session's MCP credential does not grant the battle capability. Battle tools are off, or this thread is not part of a battle.",
    });
  }
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const thread = yield* projectionSnapshotQuery
    .getThreadShellById(invocation.threadId)
    .pipe(Effect.catch((cause) => readFailed("getThreadShellById", cause)));
  const battleId = Option.getOrUndefined(thread)?.battleId ?? null;
  if (battleId === null) {
    return yield* new BattleToolError({
      reason: "thread-not-in-battle",
      detail:
        "This thread is not part of a battle, so it has no victory conditions to read or change.",
    });
  }
  const battle = yield* projectionSnapshotQuery
    .getBattleById(battleId)
    .pipe(Effect.catch((cause) => readFailed("getBattleById", cause)));
  if (Option.isNone(battle)) {
    return yield* new BattleToolError({
      reason: "battle-unavailable",
      detail: `Battle ${battleId} is no longer available.`,
    });
  }
  return { threadId: invocation.threadId, battle: battle.value };
});

/**
 * The member threads are read separately from the battle because the battle
 * entity owns no threads — membership lives on the thread's immutable
 * `battleId`, and one battle's threads can sit in different worktrees.
 */
const readStatus = Effect.fn("BattleToolkit.readStatus")(function* (scope: {
  readonly threadId: ThreadId;
  readonly battle: OrchestrationBattle;
}): Effect.fn.Return<BattleStatusResult, BattleToolError, ProjectionSnapshotQuery> {
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const shell = yield* projectionSnapshotQuery
    .getShellSnapshot()
    .pipe(Effect.catch((cause) => readFailed("getShellSnapshot", cause)));
  const members: ReadonlyArray<OrchestrationThreadShell> = shell.threads.filter(
    (thread) => thread.battleId === scope.battle.id,
  );
  return {
    battleId: scope.battle.id,
    title: scope.battle.title,
    goal: scope.battle.goal,
    phase: scope.battle.phase,
    battleLinesDrawn: battleLinesDrawn(scope.battle),
    victoryConditions: scope.battle.victoryConditions,
    threads: members.map((thread) => ({
      threadId: thread.id,
      title: thread.title,
      isCallingThread: thread.id === scope.threadId,
      branch: thread.branch,
      worktreePath: thread.worktreePath,
      sessionStatus: thread.session?.status ?? null,
    })),
  };
});

const dispatch = Effect.fn("BattleToolkit.dispatch")(function* (command: OrchestrationCommand) {
  const engine = yield* OrchestrationEngineService;
  yield* engine.dispatch(command).pipe(
    Effect.catch((cause) =>
      Effect.logWarning("Battle tool command was rejected.", {
        cause,
        commandType: command.type,
      }).pipe(
        Effect.andThen(
          new BattleToolError({
            reason: "dispatch-failed",
            detail: `The ${command.type} command was rejected.`,
          }),
        ),
      ),
    ),
  );
});

const serverIds = Effect.fn("BattleToolkit.serverIds")(function* (tag: string) {
  const crypto = yield* Crypto.Crypto;
  const uuid = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
  return {
    commandId: CommandId.make(`server:${tag}:${uuid}`),
    conditionId: VictoryConditionId.make(uuid),
  };
});

const mutationResult = (battleId: BattleId, conditionId: VictoryConditionId) => ({
  battleId,
  conditionId,
});

const handlers = {
  battle_status: () => requireBattleScope().pipe(Effect.flatMap(readStatus)),
  battle_condition_add: (input) =>
    Effect.gen(function* () {
      const scope = yield* requireBattleScope();
      const { commandId, conditionId } = yield* serverIds("battle-condition-add");
      yield* dispatch({
        type: "battle.condition.add",
        commandId,
        battleId: scope.battle.id,
        conditionId,
        title: input.title,
        ...(input.state === undefined ? {} : { state: input.state }),
        ...(input.sizeScore === undefined ? {} : { sizeScore: input.sizeScore }),
        ...(input.sizeProvisional === undefined ? {} : { sizeProvisional: input.sizeProvisional }),
        updatedByThreadId: scope.threadId,
      });
      return mutationResult(scope.battle.id, conditionId);
    }),
  battle_condition_update: (input) =>
    Effect.gen(function* () {
      const scope = yield* requireBattleScope();
      const { commandId } = yield* serverIds("battle-condition-update");
      yield* dispatch({
        type: "battle.condition.update",
        commandId,
        battleId: scope.battle.id,
        conditionId: input.conditionId,
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.state === undefined ? {} : { state: input.state }),
        ...(input.sizeScore === undefined ? {} : { sizeScore: input.sizeScore }),
        ...(input.sizeProvisional === undefined ? {} : { sizeProvisional: input.sizeProvisional }),
        ...(input.ownerThreadId === undefined ? {} : { ownerThreadId: input.ownerThreadId }),
        updatedByThreadId: scope.threadId,
      });
      return mutationResult(scope.battle.id, input.conditionId);
    }),
  battle_condition_strike: (input) =>
    Effect.gen(function* () {
      const scope = yield* requireBattleScope();
      const { commandId } = yield* serverIds("battle-condition-strike");
      yield* dispatch({
        type: "battle.condition.strike",
        commandId,
        battleId: scope.battle.id,
        conditionId: input.conditionId,
        strikeReason: input.reason,
        updatedByThreadId: scope.threadId,
      });
      return mutationResult(scope.battle.id, input.conditionId);
    }),
} satisfies Parameters<typeof BattleToolkit.toLayer>[0];

export const BattleToolkitHandlersLive = BattleToolkit.toLayer(handlers);

/** Exposed for tests. */
export const __testing = { handlers };
