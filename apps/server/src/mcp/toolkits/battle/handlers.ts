import {
  battleLinesDrawn,
  CommandId,
  IsoDateTime,
  type BattleId,
  type OrchestrationBattle,
  type OrchestrationCommand,
  type OrchestrationThreadShell,
  type ThreadId,
  VictoryConditionId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { orchestratorSendMessageId } from "../../../orchestration/battleOrchestrator.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import {
  BATTLE_THREAD_READ_DEFAULT_LIMIT,
  BATTLE_THREAD_READ_MAX_LIMIT,
  BattleOrchestratorToolkit,
  BattleToolError,
  BattleToolkit,
  type BattleStatusResult,
} from "./tools.ts";

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

interface BattleScope {
  readonly threadId: ThreadId;
  readonly battle: OrchestrationBattle;
}

/**
 * Resolves the caller as its battle's orchestrator.
 *
 * Two checks, not one: the capability says the credential was minted for an
 * orchestrator, and the battle read says it still is one. The second is what
 * survives a stale credential.
 */
const requireOrchestratorScope = Effect.fn("BattleToolkit.requireOrchestratorScope")(function* () {
  const invocation = yield* McpInvocationContext.McpInvocationContext;
  if (!invocation.capabilities.has("battle-orchestrator")) {
    return yield* new BattleToolError({
      reason: "not-orchestrator",
      detail:
        "Only the battle's orchestrator thread can reach other threads. This thread fights the battle; it does not manage it.",
    });
  }
  const scope = yield* requireBattleScope();
  if (scope.battle.orchestratorThreadId !== scope.threadId) {
    return yield* new BattleToolError({
      reason: "not-orchestrator",
      detail: `Battle ${scope.battle.id} does not name this thread as its orchestrator.`,
    });
  }
  return scope;
});

/**
 * Resolves a target thread of the caller's own battle.
 *
 * Membership is read from the shell snapshot, which carries only active
 * threads, so an archived thread cannot be targeted. Reading the caller's
 * battle from its own thread (in `requireBattleScope`) and then constraining
 * the target to that battle is the whole blast radius of these tools.
 *
 * Security posture, stated plainly: the orchestrator reads member transcripts
 * and can start turns from what it reads, so a member agent can influence what
 * other members are asked to do. The membership check keeps that influence
 * inside one battle, and `enableBattleTools` gates the surface entirely. That
 * is the accepted trade — there is no per-thread permission model here.
 */
const requireMemberTarget = Effect.fn("BattleToolkit.requireMemberTarget")(function* (
  scope: BattleScope,
  targetThreadId: ThreadId,
): Effect.fn.Return<OrchestrationThreadShell, BattleToolError, ProjectionSnapshotQuery> {
  if (targetThreadId === scope.battle.orchestratorThreadId) {
    return yield* new BattleToolError({
      reason: "target-is-orchestrator",
      detail: "That thread is this battle's orchestrator, which is you. Target a member thread.",
    });
  }
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const shell = yield* projectionSnapshotQuery
    .getShellSnapshot()
    .pipe(Effect.catch((cause) => readFailed("getShellSnapshot", cause)));
  const target = shell.threads.find((thread) => thread.id === targetThreadId);
  if (target === undefined || target.battleId !== scope.battle.id) {
    return yield* new BattleToolError({
      reason: "target-not-in-battle",
      detail: `Thread ${targetThreadId} is not an active member of battle ${scope.battle.id}. Call battle_status for the threads you can reach.`,
    });
  }
  return target;
});

/**
 * A target in one of these states is mid-turn. The send still lands — the turn
 * gate serializes it behind the running turn — so this only decides what the
 * result tells the agent.
 */
const BUSY_SESSION_STATUSES: ReadonlySet<string> = new Set(["starting", "running"]);

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
      isOrchestrator: thread.id === scope.battle.orchestratorThreadId,
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

const orchestratorHandlers = {
  battle_thread_send: (input) =>
    Effect.gen(function* () {
      const scope = yield* requireOrchestratorScope();
      const target = yield* requireMemberTarget(scope, input.threadId);
      const crypto = yield* Crypto.Crypto;
      const uuid = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
      const now = yield* DateTime.now;
      const queued = BUSY_SESSION_STATUSES.has(target.session?.status ?? "");
      yield* dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make(`server:battle-thread-send:${uuid}`),
        threadId: target.id,
        message: {
          // The report-back reactor recognises an orchestrator-initiated turn
          // from this id alone, so it must come from the shared minter.
          messageId: orchestratorSendMessageId({ battleId: scope.battle.id, uuid }),
          role: "user",
          text: input.message,
          attachments: [],
        },
        // The decider takes these from the target thread anyway; echoing the
        // thread's own modes keeps the command from implying a change.
        runtimeMode: target.runtimeMode,
        interactionMode: target.interactionMode,
        createdAt: IsoDateTime.make(DateTime.formatIso(now)),
      });
      return { threadId: target.id, queued };
    }),
  battle_thread_read: (input) =>
    Effect.gen(function* () {
      const scope = yield* requireOrchestratorScope();
      const target = yield* requireMemberTarget(scope, input.threadId);
      const limit = Math.min(
        input.limit ?? BATTLE_THREAD_READ_DEFAULT_LIMIT,
        BATTLE_THREAD_READ_MAX_LIMIT,
      );
      const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
      // Windowed on purpose: the unwindowed read hydrates the entire thread
      // body, which is far more than a catch-up needs. One turn yields at
      // least one message, so `limit` turns always cover `limit` messages.
      const snapshot = yield* projectionSnapshotQuery
        .getThreadDetailSnapshot(target.id, { turnLimit: limit })
        .pipe(Effect.catch((cause) => readFailed("getThreadDetailSnapshot", cause)));
      if (Option.isNone(snapshot)) {
        return yield* new BattleToolError({
          reason: "read-failed",
          detail: `Thread ${target.id} could not be read.`,
        });
      }
      return {
        threadId: target.id,
        title: target.title,
        messages: snapshot.value.thread.messages.slice(-limit).map((message) => ({
          messageId: message.id,
          role: message.role,
          text: message.text,
          createdAt: message.createdAt,
        })),
      };
    }),
} satisfies Parameters<typeof BattleOrchestratorToolkit.toLayer>[0];

export const BattleOrchestratorToolkitHandlersLive =
  BattleOrchestratorToolkit.toLayer(orchestratorHandlers);

/** Exposed for tests. */
export const __testing = { handlers, orchestratorHandlers };
