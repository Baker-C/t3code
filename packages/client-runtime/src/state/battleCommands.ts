import * as Crypto from "effect/Crypto";
import { Atom } from "effect/unstable/reactivity";

import { createAtomCommandScheduler, createEnvironmentCommand } from "./runtime.ts";
import {
  type AddBattleConditionInput,
  type AddBattleToQueueInput,
  type ClearQueueActionInput,
  type CreateBattleInput,
  type DeclareBattleDefeatInput,
  type DeclareBattleFightingInput,
  type DeleteBattleInput,
  type RefreshBattleOrchestratorInput,
  type RemoveBattlesFromQueueInput,
  type ReopenBattleInput,
  type SetQueueActionWakeRuleInput,
  type SkipQueuedBattleInput,
  type StrikeBattleConditionInput,
  type UpdateBattleConditionInput,
  type UpdateBattleMetadataInput,
  addBattleCondition,
  addBattleToQueue,
  clearQueueAction,
  createBattle,
  declareBattleDefeat,
  declareBattleFighting,
  deleteBattle,
  refreshBattleOrchestrator,
  removeBattlesFromQueue,
  reopenBattle,
  setQueueActionWakeRule,
  skipQueuedBattle,
  strikeBattleCondition,
  updateBattleCondition,
  updateBattleMetadata,
} from "../operations/commands.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";

export type {
  AddBattleConditionInput,
  AddBattleToQueueInput,
  ClearQueueActionInput,
  CreateBattleInput,
  DeclareBattleDefeatInput,
  DeclareBattleFightingInput,
  DeleteBattleInput,
  RefreshBattleOrchestratorInput,
  RemoveBattlesFromQueueInput,
  ReopenBattleInput,
  SetQueueActionWakeRuleInput,
  SkipQueuedBattleInput,
  StrikeBattleConditionInput,
  UpdateBattleConditionInput,
  UpdateBattleMetadataInput,
} from "../operations/commands.ts";

export function createBattleEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | Crypto.Crypto | R, E>,
) {
  const scheduler = createAtomCommandScheduler();
  const concurrency = {
    mode: "serial" as const,
    key: ({ environmentId, input }: { environmentId: string; input: { battleId: string } }) =>
      JSON.stringify([environmentId, input.battleId]),
  };
  return {
    create: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:battle:create",
      execute: (input: CreateBattleInput) => createBattle(input),
      scheduler,
      concurrency,
    }),
    updateMetadata: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:battle:update-metadata",
      execute: (input: UpdateBattleMetadataInput) => updateBattleMetadata(input),
      scheduler,
      concurrency,
    }),
    addCondition: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:battle:add-condition",
      execute: (input: AddBattleConditionInput) => addBattleCondition(input),
      scheduler,
      concurrency,
    }),
    updateCondition: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:battle:update-condition",
      execute: (input: UpdateBattleConditionInput) => updateBattleCondition(input),
      scheduler,
      concurrency,
    }),
    strikeCondition: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:battle:strike-condition",
      execute: (input: StrikeBattleConditionInput) => strikeBattleCondition(input),
      scheduler,
      concurrency,
    }),
    declareFighting: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:battle:declare-fighting",
      execute: (input: DeclareBattleFightingInput) => declareBattleFighting(input),
      scheduler,
      concurrency,
    }),
    declareDefeat: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:battle:declare-defeat",
      execute: (input: DeclareBattleDefeatInput) => declareBattleDefeat(input),
      scheduler,
      concurrency,
    }),
    reopen: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:battle:reopen",
      execute: (input: ReopenBattleInput) => reopenBattle(input),
      scheduler,
      concurrency,
    }),
    refreshOrchestrator: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:battle:refresh-orchestrator",
      execute: (input: RefreshBattleOrchestratorInput) => refreshBattleOrchestrator(input),
      scheduler,
      concurrency,
    }),
    delete: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:battle:delete",
      execute: (input: DeleteBattleInput) => deleteBattle(input),
      scheduler,
      concurrency,
    }),
    /**
     * Queue commands. Removal takes a list of battles rather than one, so it
     * serializes on the queue itself instead of a single battle id.
     */
    queueAdd: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:battle:queue-add",
      execute: (input: AddBattleToQueueInput) => addBattleToQueue(input),
      scheduler,
      concurrency,
    }),
    queueRemove: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:battle:queue-remove",
      execute: (input: RemoveBattlesFromQueueInput) => removeBattlesFromQueue(input),
      scheduler,
      concurrency: {
        mode: "serial" as const,
        key: ({ environmentId }: { environmentId: string }) =>
          JSON.stringify([environmentId, "queue"]),
      },
    }),
    queueSkip: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:battle:queue-skip",
      execute: (input: SkipQueuedBattleInput) => skipQueuedBattle(input),
      scheduler,
      concurrency,
    }),
    queueSetActionWakeRule: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:battle:queue-set-action-wake-rule",
      execute: (input: SetQueueActionWakeRuleInput) => setQueueActionWakeRule(input),
      scheduler,
      concurrency,
    }),
    queueClearAction: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:battle:queue-clear-action",
      execute: (input: ClearQueueActionInput) => clearQueueAction(input),
      scheduler,
      concurrency,
    }),
  };
}
