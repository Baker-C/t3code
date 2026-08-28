import * as Crypto from "effect/Crypto";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createAtomCommandScheduler, createEnvironmentCommand } from "./runtime.ts";
import {
  type AddBattleToQueueInput,
  type ClearQueueActionInput,
  type RemoveBattlesFromQueueInput,
  type SetBattlePriorityInput,
  type SetBattleThreadGroupsInput,
  type SetProjectPriorityInput,
  type SetQueueActionWakeRuleInput,
  type SkipQueuedBattleInput,
  addBattleToQueue,
  clearQueueAction,
  removeBattlesFromQueue,
  setBattlePriority,
  setBattleThreadGroups,
  setProjectPriority,
  setQueueActionWakeRule,
  skipQueuedBattle,
} from "../operations/commands.ts";

export type {
  AddBattleToQueueInput,
  ClearQueueActionInput,
  RemoveBattlesFromQueueInput,
  SetBattlePriorityInput,
  SetBattleThreadGroupsInput,
  SetProjectPriorityInput,
  SetQueueActionWakeRuleInput,
  SkipQueuedBattleInput,
};

/**
 * Queue command atoms, shared by web and mobile.
 *
 * Battle-scoped commands serialize per battle, so a double-click on add or
 * skip cannot race itself into two dispatches. The multi-row clear and the
 * project priority set are keyed differently because neither names a single
 * battle.
 */
export function createQueueEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | Crypto.Crypto | R, E>,
) {
  const scheduler = createAtomCommandScheduler();
  const battleConcurrency = {
    mode: "serial" as const,
    key: ({ environmentId, input }: { environmentId: string; input: { battleId: string } }) =>
      JSON.stringify([environmentId, input.battleId]),
  };
  const environmentConcurrency = {
    mode: "serial" as const,
    key: ({ environmentId }: { environmentId: string }) => environmentId,
  };
  return {
    addBattle: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:queue:add-battle",
      execute: (input: AddBattleToQueueInput) => addBattleToQueue(input),
      scheduler,
      concurrency: battleConcurrency,
    }),
    removeBattles: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:queue:remove-battles",
      execute: (input: RemoveBattlesFromQueueInput) => removeBattlesFromQueue(input),
      scheduler,
      concurrency: environmentConcurrency,
    }),
    skipBattle: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:queue:skip-battle",
      execute: (input: SkipQueuedBattleInput) => skipQueuedBattle(input),
      scheduler,
      concurrency: battleConcurrency,
    }),
    setActionWakeRule: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:queue:set-action-wake-rule",
      execute: (input: SetQueueActionWakeRuleInput) => setQueueActionWakeRule(input),
      scheduler,
      concurrency: battleConcurrency,
    }),
    clearAction: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:queue:clear-action",
      execute: (input: ClearQueueActionInput) => clearQueueAction(input),
      scheduler,
      concurrency: battleConcurrency,
    }),
    setBattlePriority: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:queue:set-battle-priority",
      execute: (input: SetBattlePriorityInput) => setBattlePriority(input),
      scheduler,
      concurrency: battleConcurrency,
    }),
    setBattleThreadGroups: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:queue:set-battle-thread-groups",
      execute: (input: SetBattleThreadGroupsInput) => setBattleThreadGroups(input),
      scheduler,
      concurrency: battleConcurrency,
    }),
    setProjectPriority: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:queue:set-project-priority",
      execute: (input: SetProjectPriorityInput) => setProjectPriority(input),
      scheduler,
      concurrency: environmentConcurrency,
    }),
  };
}
