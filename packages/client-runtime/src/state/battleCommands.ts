import * as Crypto from "effect/Crypto";
import { Atom } from "effect/unstable/reactivity";

import { createAtomCommandScheduler, createEnvironmentCommand } from "./runtime.ts";
import {
  type AddBattleConditionInput,
  type CreateBattleInput,
  type DeclareBattleDefeatInput,
  type DeclareBattleFightingInput,
  type DeleteBattleInput,
  type ReopenBattleInput,
  type StrikeBattleConditionInput,
  type UpdateBattleConditionInput,
  type UpdateBattleMetadataInput,
  addBattleCondition,
  createBattle,
  declareBattleDefeat,
  declareBattleFighting,
  deleteBattle,
  reopenBattle,
  strikeBattleCondition,
  updateBattleCondition,
  updateBattleMetadata,
} from "../operations/commands.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";

export type {
  AddBattleConditionInput,
  CreateBattleInput,
  DeclareBattleDefeatInput,
  DeclareBattleFightingInput,
  DeleteBattleInput,
  ReopenBattleInput,
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
    delete: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:battle:delete",
      execute: (input: DeleteBattleInput) => deleteBattle(input),
      scheduler,
      concurrency,
    }),
  };
}
