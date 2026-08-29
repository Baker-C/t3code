import { useAtomValue } from "@effect/atom-react";
import {
  buildQueueRows,
  queueSkipAvailability,
  selectNextQueueRow,
  type QueueCycleOptions,
  type QueuePriorityOptions,
  type QueueRow,
  type QueueRowSource,
  type QueueSkipAvailability,
} from "@t3tools/client-runtime/state/battle-queue";
import type { BattleQueueEntry, EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";
import { useMemo } from "react";

import { environmentCatalog } from "../connection/catalog";
import { useEnvironments } from "./environments";
import { environmentSnapshotAtom } from "./shell";

const EMPTY_ENTRIES: ReadonlyArray<BattleQueueEntry> = Object.freeze([]);
const EMPTY_SOURCES: ReadonlyArray<QueueRowSource> = Object.freeze([]);

/**
 * One environment's queue rows, joined against that environment's battles and
 * projects. A queue never spans environments — entries point at battles,
 * battles belong to projects, projects belong to one environment — so the
 * join is always local and the client merges the results.
 */
const environmentQueueSourcesAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get): ReadonlyArray<QueueRowSource> => {
    const snapshot = get(environmentSnapshotAtom(environmentId));
    const entries = snapshot?.queueEntries ?? EMPTY_ENTRIES;
    if (entries.length === 0) return EMPTY_SOURCES;
    const battlesById = new Map((snapshot?.battles ?? []).map((battle) => [battle.id, battle]));
    const projectsById = new Map(
      (snapshot?.projects ?? []).map((project) => [project.id, project]),
    );
    const sources: QueueRowSource[] = [];
    for (const entry of entries) {
      const battle = battlesById.get(entry.battleId);
      // A queued battle that is gone from the shell is a projection race, not
      // a row to render: the decider drops the entry with the battle.
      if (battle === undefined || battle.deletedAt !== null) continue;
      const project = projectsById.get(battle.projectId);
      sources.push({
        environmentId,
        // Filled in by the caller, which is the only place that knows what
        // the user calls this environment.
        environmentLabel: "",
        entry,
        battle,
        project:
          project === undefined ? null : { title: project.title, priority: project.priority },
      });
    }
    return sources.length === 0 ? EMPTY_SOURCES : sources;
  }).pipe(Atom.withLabel(`web-battle-queue-sources:${environmentId}`)),
);

/** Every connected environment's queue, unlabelled and unordered. */
const queueSourcesAtom = Atom.make((get): ReadonlyArray<QueueRowSource> => {
  const sources: QueueRowSource[] = [];
  for (const environmentId of get(environmentCatalog.catalogValueAtom).entries.keys()) {
    sources.push(...get(environmentQueueSourcesAtom(environmentId)));
  }
  return sources.length === 0 ? EMPTY_SOURCES : sources;
}).pipe(Atom.withLabel("web-battle-queue-sources"));

/**
 * The merged, ordered queue across every connected environment, with each row
 * carrying the label of the environment it will execute in. Rows interleave by
 * priority rather than grouping by machine.
 */
export function useQueueRows(options: QueuePriorityOptions): ReadonlyArray<QueueRow> {
  const sources = useAtomValue(queueSourcesAtom);
  const { environments } = useEnvironments();
  const labelById = useMemo(
    () =>
      new Map(environments.map((environment) => [environment.environmentId, environment.label])),
    [environments],
  );
  return useMemo(
    () =>
      buildQueueRows(
        sources.map((source) => ({
          ...source,
          environmentLabel: labelById.get(source.environmentId) ?? "",
        })),
        options,
      ),
    [labelById, options, sources],
  );
}

/** The battle the cycle would hand you next, or null when nothing is ready. */
export function useNextQueueRow(
  rows: ReadonlyArray<QueueRow>,
  options: QueueCycleOptions,
): QueueRow | null {
  return useMemo(() => selectNextQueueRow(rows, options), [options, rows]);
}

/** Whether passing over the current battle would take you anywhere, and why not. */
export function useQueueSkipAvailability(
  rows: ReadonlyArray<QueueRow>,
  options: QueueCycleOptions,
): QueueSkipAvailability {
  return useMemo(() => queueSkipAvailability(rows, options), [options, rows]);
}
