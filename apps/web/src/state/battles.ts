import { useAtomValue } from "@effect/atom-react";
import { createBattleEnvironmentAtoms } from "@t3tools/client-runtime/state/battle-commands";
import type { BattleId, EnvironmentId, OrchestrationBattle } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";
import { environmentSnapshotAtom } from "./shell";

export const battleEnvironment = createBattleEnvironmentAtoms(connectionAtomRuntime);

export interface EnvironmentBattle extends OrchestrationBattle {
  readonly environmentId: EnvironmentId;
}

const EMPTY_BATTLES: ReadonlyArray<OrchestrationBattle> = Object.freeze([]);
const EMPTY_ENVIRONMENT_BATTLES: ReadonlyArray<EnvironmentBattle> = Object.freeze([]);

const EMPTY_BATTLES_ATOM = Atom.make(EMPTY_ENVIRONMENT_BATTLES).pipe(
  Atom.withLabel("web-environment-battles:empty"),
);

const environmentBattlesAtom = Atom.family((environmentId: EnvironmentId) => {
  let previousSource: ReadonlyArray<OrchestrationBattle> = EMPTY_BATTLES;
  let previousValue: ReadonlyArray<EnvironmentBattle> = EMPTY_ENVIRONMENT_BATTLES;
  return Atom.make((get): ReadonlyArray<EnvironmentBattle> => {
    const source = get(environmentSnapshotAtom(environmentId))?.battles ?? EMPTY_BATTLES;
    if (source === previousSource) {
      return previousValue;
    }
    previousSource = source;
    previousValue =
      source.length === 0
        ? EMPTY_ENVIRONMENT_BATTLES
        : source.map((battle) => ({ ...battle, environmentId }));
    return previousValue;
  }).pipe(Atom.withLabel(`web-environment-battles:${environmentId}`));
});

/** Live battles across every connected environment; deleted battles are
    dropped here so no surface has to remember to filter them. */
export const battlesAtom = Atom.make((get): ReadonlyArray<EnvironmentBattle> => {
  const battles: EnvironmentBattle[] = [];
  for (const environmentId of get(environmentCatalog.catalogValueAtom).entries.keys()) {
    for (const battle of get(environmentBattlesAtom(environmentId))) {
      if (battle.deletedAt === null) battles.push(battle);
    }
  }
  return battles.length === 0 ? EMPTY_ENVIRONMENT_BATTLES : battles;
}).pipe(Atom.withLabel("web-battles"));

export function useBattles(): ReadonlyArray<EnvironmentBattle> {
  return useAtomValue(battlesAtom);
}

export function useBattle(
  environmentId: EnvironmentId | null,
  battleId: BattleId | null | undefined,
): EnvironmentBattle | null {
  const battles = useAtomValue(
    environmentId === null ? EMPTY_BATTLES_ATOM : environmentBattlesAtom(environmentId),
  );
  return battleId == null ? null : (battles.find((battle) => battle.id === battleId) ?? null);
}
