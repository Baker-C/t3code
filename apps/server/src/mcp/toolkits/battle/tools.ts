import {
  BattleId,
  BattlePhase,
  IsoDateTime,
  MessageId,
  OrchestrationMessageRole,
  PositiveInt,
  ThreadId,
  TrimmedNonEmptyString,
  VictoryCondition,
  VictoryConditionId,
  VictoryConditionSizeScore,
  VictoryConditionState,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  OrchestrationEngineService,
  ProjectionSnapshotQuery,
  Crypto.Crypto,
];

/**
 * Every way a battle tool can refuse. The toolkit carries its own error
 * because the preview refusal in contracts pins its capability to "preview".
 */
export const BattleToolErrorReason = Schema.Literals([
  "capability-unavailable",
  "thread-not-in-battle",
  "battle-unavailable",
  "read-failed",
  "dispatch-failed",
  // Orchestrator-only refusals. They are separate reasons because the agent
  // can act on each differently: re-read the battle, pick another target, or
  // stop trying to message itself.
  "not-orchestrator",
  "target-not-in-battle",
  "target-is-orchestrator",
]);
export type BattleToolErrorReason = typeof BattleToolErrorReason.Type;

export class BattleToolError extends Schema.TaggedErrorClass<BattleToolError>()("BattleToolError", {
  reason: BattleToolErrorReason,
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}

const BattleMemberThread = Schema.Struct({
  threadId: ThreadId,
  title: TrimmedNonEmptyString,
  // The thread this tool call came from, so the agent can tell itself apart
  // from its siblings without knowing its own id.
  isCallingThread: Schema.Boolean,
  // The battle's manager thread. Ships to members too, so a member agent can
  // tell the orchestrator apart from its peers.
  isOrchestrator: Schema.Boolean,
  branch: Schema.NullOr(TrimmedNonEmptyString),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  sessionStatus: Schema.NullOr(TrimmedNonEmptyString),
});

const BattleStatusResult = Schema.Struct({
  battleId: BattleId,
  title: TrimmedNonEmptyString,
  goal: Schema.NullOr(TrimmedNonEmptyString),
  phase: BattlePhase,
  // True once every condition is scoped or descoped and at least one survived.
  battleLinesDrawn: Schema.Boolean,
  victoryConditions: Schema.Array(VictoryCondition),
  threads: Schema.Array(BattleMemberThread),
});
export type BattleStatusResult = typeof BattleStatusResult.Type;

const BattleConditionMutationResult = Schema.Struct({
  battleId: BattleId,
  conditionId: VictoryConditionId,
}).annotate({
  description:
    "The change is recorded. Call battle_status to read the battle back after the change lands.",
});

const NoParameters = Schema.Struct({});

const SCOPE_SEMANTICS =
  "A victory condition is a unit of scope, not of completion: it is met once its plan is pinned (state 'scoped'), before any code lands.";

export const BattleStatusTool = Tool.make("battle_status", {
  description: `Read this thread's battle: goal, phase, every victory condition with its state, size score and owner, whether the battle lines are drawn, and the sibling threads fighting it with their branch, worktree and session status. ${SCOPE_SEMANTICS} Read the battle before planning so you do not re-scope work a sibling thread already owns.`,
  parameters: NoParameters,
  success: BattleStatusResult,
  failure: BattleToolError,
  dependencies,
})
  .annotate(Tool.Title, "Read battle status")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const BattleConditionAddTool = Tool.make("battle_condition_add", {
  description: `Add a victory condition to this thread's battle. Add one whenever the conversation reveals scope the battle does not cover yet — an unlisted requirement, a dependency the goal implies, a follow-up the user asks for mid-turn. ${SCOPE_SEMANTICS} Leave state 'unscoped' unless you are adding something you have already planned. Give sizeScore 0-5 only when you can defend it, and set sizeProvisional=true while the estimate precedes the plan.`,
  parameters: Schema.Struct({
    title: TrimmedNonEmptyString,
    state: Schema.optional(VictoryConditionState),
    sizeScore: Schema.optional(Schema.NullOr(VictoryConditionSizeScore)),
    sizeProvisional: Schema.optional(Schema.Boolean),
  }),
  success: BattleConditionMutationResult,
  failure: BattleToolError,
  dependencies,
})
  .annotate(Tool.Title, "Add victory condition")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false);

export const BattleConditionUpdateTool = Tool.make("battle_condition_update", {
  description: `Update one victory condition of this thread's battle. Omitted fields stay unchanged. Move a condition to 'scoping' when you start planning it and to 'scoped' the moment its plan is pinned — that is what "met" means here, so do not wait for the implementation. ${SCOPE_SEMANTICS} Drop sizeProvisional to false once the score comes from a finished plan, and set ownerThreadId to the thread that will fight the condition.`,
  parameters: Schema.Struct({
    conditionId: VictoryConditionId,
    title: Schema.optional(TrimmedNonEmptyString),
    state: Schema.optional(VictoryConditionState),
    sizeScore: Schema.optional(Schema.NullOr(VictoryConditionSizeScore)),
    sizeProvisional: Schema.optional(Schema.Boolean),
    ownerThreadId: Schema.optional(Schema.NullOr(ThreadId)),
  }),
  success: BattleConditionMutationResult,
  failure: BattleToolError,
  dependencies,
})
  .annotate(Tool.Title, "Update victory condition")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const BattleConditionStrikeTool = Tool.make("battle_condition_strike", {
  description:
    "Strike a victory condition out of this thread's battle: it becomes 'descoped' and stays in the record with your reason attached, so the battle keeps the history of what was dropped and why. Use this when scope is cut, superseded, or found to be already satisfied. The reason is required and is shown to the user, so make it specific.",
  parameters: Schema.Struct({
    conditionId: VictoryConditionId,
    reason: TrimmedNonEmptyString,
  }),
  success: BattleConditionMutationResult,
  failure: BattleToolError,
  dependencies,
})
  .annotate(Tool.Title, "Strike victory condition")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true);

export const BattleToolkit = Toolkit.make(
  BattleStatusTool,
  BattleConditionAddTool,
  BattleConditionUpdateTool,
  BattleConditionStrikeTool,
);

/**
 * The default and the ceiling for `battle_thread_read`. The read is bounded on
 * both ends so one tool call can never pull a whole member transcript into the
 * orchestrator's context.
 */
export const BATTLE_THREAD_READ_DEFAULT_LIMIT = 20;
export const BATTLE_THREAD_READ_MAX_LIMIT = 100;

const BattleThreadSendResult = Schema.Struct({
  threadId: ThreadId,
  // True when the target was already mid-turn. The send still landed; it sits
  // behind the running turn instead of starting one now.
  queued: Schema.Boolean,
}).annotate({
  description:
    "The message is on its way. The member's reply is delivered to this thread on its own when the turn finishes.",
});

const BattleThreadMessage = Schema.Struct({
  messageId: MessageId,
  role: OrchestrationMessageRole,
  text: Schema.String,
  createdAt: IsoDateTime,
});

const BattleThreadReadResult = Schema.Struct({
  threadId: ThreadId,
  title: TrimmedNonEmptyString,
  // Chronological, oldest first, so the last entry is the newest message.
  messages: Schema.Array(BattleThreadMessage),
});

export const BattleThreadSendTool = Tool.make("battle_thread_send", {
  description:
    "Send a message to one member thread of this battle, as its user. Only the battle's orchestrator thread may call this, and only for a thread fighting the same battle. The call returns as soon as the message is recorded: it never waits for the answer, and a send to a thread that is already mid-turn queues behind that turn rather than failing (the result reports queued=true). The member's reply is delivered to you automatically when its turn finishes, so do not poll for it and do not send again to check.",
  parameters: Schema.Struct({
    threadId: ThreadId,
    message: TrimmedNonEmptyString,
  }),
  success: BattleThreadSendResult,
  failure: BattleToolError,
  dependencies,
})
  .annotate(Tool.Title, "Message a battle thread")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false);

export const BattleThreadReadTool = Tool.make("battle_thread_read", {
  description: `Read the most recent messages of one member thread of this battle. Only the battle's orchestrator thread may call this, and only for a thread fighting the same battle. Use it to catch up on a thread you have not messaged, or to re-read context you have lost — replies to your own sends already arrive on their own. Messages come back oldest first, capped by limit (default ${BATTLE_THREAD_READ_DEFAULT_LIMIT}, maximum ${BATTLE_THREAD_READ_MAX_LIMIT}).`,
  parameters: Schema.Struct({
    threadId: ThreadId,
    limit: Schema.optional(PositiveInt),
  }),
  success: BattleThreadReadResult,
  failure: BattleToolError,
  dependencies,
})
  .annotate(Tool.Title, "Read a battle thread")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

/**
 * The cross-thread half of the battle surface, split out so it can be granted
 * on its own capability. Every tool here reaches into a thread other than the
 * caller's, which is exactly what the plain `battle` capability must not buy.
 */
export const BattleOrchestratorToolkit = Toolkit.make(BattleThreadSendTool, BattleThreadReadTool);
