import {
  BattleId,
  BattlePhase,
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
