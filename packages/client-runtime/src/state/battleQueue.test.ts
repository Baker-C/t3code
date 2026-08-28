import {
  BattleId,
  DEFAULT_QUEUE_WAKE_RULE,
  EnvironmentId,
  ProjectId,
  QueueActionId,
  ThreadId,
  type BattleQueueEntry,
  type QueueAction,
  type QueueActionOutcome,
  type QueuePriority,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildQueueRows,
  eligibleQueueRows,
  queueRowKey,
  queueSkipAvailability,
  queuedQueueRows,
  selectNextQueueRow,
  visibleQueueRows,
  type QueueRowSource,
} from "./battleQueue.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const LOCAL = EnvironmentId.make("local");
const REMOTE = EnvironmentId.make("remote");

function makeAction(input: Partial<QueueAction> = {}): QueueAction {
  return {
    id: input.id ?? QueueActionId.make("action-1"),
    threadIds: input.threadIds ?? [ThreadId.make("thread-1")],
    wakeRule: input.wakeRule ?? DEFAULT_QUEUE_WAKE_RULE,
    outcome: input.outcome ?? null,
    startedAt: NOW,
    readyAt: input.outcome === undefined || input.outcome === null ? null : NOW,
  };
}

function makeSource(input: {
  readonly id: string;
  readonly environmentId?: EnvironmentId;
  readonly battlePriority?: QueuePriority;
  readonly projectPriority?: QueuePriority;
  readonly orderKey?: number;
  readonly skippedInLap?: boolean;
  readonly outcomes?: ReadonlyArray<QueueActionOutcome | null>;
}): QueueRowSource {
  const battleId = BattleId.make(input.id);
  const actions = (input.outcomes ?? []).map((outcome, index) =>
    makeAction({ id: QueueActionId.make(`${input.id}-action-${index}`), outcome }),
  );
  const entry: BattleQueueEntry = {
    battleId,
    projectId: ProjectId.make("project-1"),
    orderKey: input.orderKey ?? 0,
    skippedInLap: input.skippedInLap ?? false,
    actions,
    addedAt: NOW,
    updatedAt: NOW,
  };
  return {
    environmentId: input.environmentId ?? LOCAL,
    environmentLabel: input.environmentId === REMOTE ? "Work laptop" : "This machine",
    entry,
    battle: {
      id: battleId,
      title: `Battle ${input.id}`,
      projectId: ProjectId.make("project-1"),
      ...(input.battlePriority === undefined ? {} : { priority: input.battlePriority }),
    },
    project: {
      title: "Project",
      ...(input.projectPriority === undefined ? {} : { priority: input.projectPriority }),
    },
  };
}

const ready = (id: string, rest: Partial<Parameters<typeof makeSource>[0]> = {}) =>
  makeSource({ id, outcomes: ["completed"], ...rest });

const keys = (rows: ReadonlyArray<{ readonly key: string }>) => rows.map((row) => row.key);

describe("battle queue ordering", () => {
  it("orders by compounded priority, not lexicographically by project", () => {
    const rows = buildQueueRows([
      // A low-priority chore in a top-priority project.
      ready("work-chore", { projectPriority: 3, battlePriority: 1 }),
      // An urgent fire in an unprioritised personal project.
      ready("personal-fire", { projectPriority: 0, battlePriority: 3 }),
    ]);
    // Compounded: 4 vs 3, so the work chore still wins here...
    expect(keys(rows)[0]).toBe(queueRowKey(LOCAL, BattleId.make("work-chore")));

    const flipped = buildQueueRows([
      ready("work-chore", { projectPriority: 1, battlePriority: 1 }),
      ready("personal-fire", { projectPriority: 0, battlePriority: 3 }),
    ]);
    // ...but a top-priority personal battle genuinely beats a low-priority
    // work one, which lexicographic sorting could never express.
    expect(keys(flipped)[0]).toBe(queueRowKey(LOCAL, BattleId.make("personal-fire")));
  });

  it("lands an unprioritised project's top battle mid-pack", () => {
    const rows = buildQueueRows([
      ready("a", { projectPriority: 0, battlePriority: 3 }),
      ready("b", { projectPriority: 3, battlePriority: 0 }),
    ]);
    // Both compound to 3, so the tie breaks on tier position, not on which
    // dimension carried the score.
    expect(rows[0]?.compoundedPriority).toBe(3);
    expect(rows[1]?.compoundedPriority).toBe(3);
  });

  it("breaks ties by position within the tier", () => {
    const rows = buildQueueRows([
      ready("second", { orderKey: 5 }),
      ready("first", { orderKey: 1 }),
    ]);
    expect(keys(rows)).toEqual([
      queueRowKey(LOCAL, BattleId.make("first")),
      queueRowKey(LOCAL, BattleId.make("second")),
    ]);
  });

  it("interleaves environments rather than grouping by them", () => {
    const rows = buildQueueRows([
      ready("local-low", { battlePriority: 1 }),
      ready("remote-high", { environmentId: REMOTE, battlePriority: 3 }),
      ready("local-mid", { battlePriority: 2 }),
    ]);
    expect(rows.map((row) => row.battleId)).toEqual(["remote-high", "local-mid", "local-low"]);
    expect(rows[0]?.environmentLabel).toBe("Work laptop");
  });

  it("flattens a dimension the settings turned off", () => {
    const sources = [
      ready("work", { projectPriority: 3, battlePriority: 0 }),
      ready("personal", { projectPriority: 0, battlePriority: 2, orderKey: 1 }),
    ];
    const flat = buildQueueRows(sources, {
      projectPriorityEnabled: false,
      battlePriorityEnabled: true,
    });
    expect(flat.map((row) => row.battleId)).toEqual(["personal", "work"]);
    expect(flat[1]?.compoundedPriority).toBe(0);
  });

  it("reads a battle as ready when any action is, and marks errors in place", () => {
    const rows = buildQueueRows([
      // Ready and busy at once: one action wants you, another is in flight.
      makeSource({ id: "mixed", outcomes: ["errored", null] }),
    ]);
    expect(rows[0]?.state).toBe("ready");
    expect(rows[0]?.hasErrored).toBe(true);
    expect(rows[0]?.readyActions).toHaveLength(1);
    expect(rows[0]?.pendingActions).toHaveLength(1);
  });

  it("does not promote an errored battle out of its tier", () => {
    const rows = buildQueueRows([
      makeSource({ id: "low-error", battlePriority: 1, outcomes: ["errored"] }),
      makeSource({ id: "high-ok", battlePriority: 3, outcomes: ["completed"] }),
    ]);
    // A failure must not override your judgement about what matters.
    expect(rows.map((row) => row.battleId)).toEqual(["high-ok", "low-error"]);
  });

  it("separates the main list from the queued-actions toggle", () => {
    const rows = buildQueueRows([
      ready("ready-row"),
      makeSource({ id: "dormant", orderKey: 1 }),
      makeSource({ id: "busy-row", orderKey: 2, outcomes: [null] }),
    ]);
    expect(visibleQueueRows(rows).map((row) => row.battleId)).toEqual(["ready-row", "dormant"]);
    expect(queuedQueueRows(rows).map((row) => row.battleId)).toEqual(["busy-row"]);
  });
});

describe("battle queue cycling", () => {
  const cycle = { roundRobinEnabled: true } as const;

  it("offers the highest-priority ready battle that is not the current one", () => {
    const rows = buildQueueRows([
      ready("top", { battlePriority: 3 }),
      ready("next", { battlePriority: 2 }),
    ]);
    expect(
      selectNextQueueRow(rows, { ...cycle, currentKey: queueRowKey(LOCAL, BattleId.make("top")) })
        ?.battleId,
    ).toBe("next");
  });

  it("never offers a not-started or busy battle", () => {
    const rows = buildQueueRows([
      makeSource({ id: "dormant", battlePriority: 3 }),
      makeSource({ id: "busy", battlePriority: 3, orderKey: 1, outcomes: [null] }),
      ready("ready-row", { battlePriority: 1, orderKey: 2 }),
    ]);
    expect(selectNextQueueRow(rows, { ...cycle, currentKey: null })?.battleId).toBe("ready-row");
  });

  it("passes over a battle already skipped this lap", () => {
    const rows = buildQueueRows([
      ready("skipped", { battlePriority: 3, skippedInLap: true }),
      ready("fresh", { battlePriority: 1, orderKey: 1 }),
    ]);
    expect(selectNextQueueRow(rows, { ...cycle, currentKey: null })?.battleId).toBe("fresh");
  });

  it("ignores the lap entirely when round-robin is off", () => {
    const rows = buildQueueRows([
      ready("skipped", { battlePriority: 3, skippedInLap: true }),
      ready("fresh", { battlePriority: 1, orderKey: 1 }),
    ]);
    expect(selectNextQueueRow(rows, { currentKey: null, roundRobinEnabled: false })?.battleId).toBe(
      "skipped",
    );
  });

  it("offers nothing when the only ready battle is the one you are in", () => {
    const rows = buildQueueRows([ready("only")]);
    expect(
      selectNextQueueRow(rows, { ...cycle, currentKey: queueRowKey(LOCAL, BattleId.make("only")) }),
    ).toBeNull();
  });
});

describe("battle queue skip availability", () => {
  const cycle = { roundRobinEnabled: true } as const;
  const keyFor = (id: string) => queueRowKey(LOCAL, BattleId.make(id));

  it("allows a skip when there is somewhere else to go", () => {
    const rows = buildQueueRows([ready("current"), ready("other", { orderKey: 1 })]);
    expect(queueSkipAvailability(rows, { ...cycle, currentKey: keyFor("current") })).toEqual({
      canSkip: true,
    });
  });

  it("disables the skip when the current battle is the only ready one", () => {
    const rows = buildQueueRows([
      ready("only"),
      // Neither of these is offerable, so neither rescues the lap.
      makeSource({ id: "dormant", orderKey: 1 }),
      makeSource({ id: "busy", orderKey: 2, outcomes: [null] }),
    ]);
    // Skipping the only eligible battle is also the skip that ends the lap, so
    // it would clear itself and come straight back.
    expect(queueSkipAvailability(rows, { ...cycle, currentKey: keyFor("only") })).toEqual({
      canSkip: false,
      reason: "nothing-else-ready",
    });
  });

  it("disables the skip when no battle is ready at all", () => {
    const rows = buildQueueRows([makeSource({ id: "dormant" })]);
    expect(queueSkipAvailability(rows, { ...cycle, currentKey: keyFor("dormant") })).toEqual({
      canSkip: false,
      reason: "not-ready",
    });
  });

  it("disables the skip on an empty queue", () => {
    expect(queueSkipAvailability([], { ...cycle, currentKey: null })).toEqual({
      canSkip: false,
      reason: "not-queued",
    });
  });

  it("disables the skip outside the queue", () => {
    const rows = buildQueueRows([ready("queued"), ready("other", { orderKey: 1 })]);
    expect(queueSkipAvailability(rows, { ...cycle, currentKey: keyFor("unqueued") })).toEqual({
      canSkip: false,
      reason: "not-queued",
    });
  });

  it("disables a second skip of the same battle in one lap", () => {
    const rows = buildQueueRows([
      ready("current", { skippedInLap: true }),
      ready("other", { orderKey: 1 }),
    ]);
    expect(queueSkipAvailability(rows, { ...cycle, currentKey: keyFor("current") })).toEqual({
      canSkip: false,
      reason: "already-skipped",
    });
  });

  it("hides the skip when round-robin is turned off", () => {
    const rows = buildQueueRows([ready("current"), ready("other", { orderKey: 1 })]);
    expect(
      queueSkipAvailability(rows, { currentKey: keyFor("current"), roundRobinEnabled: false }),
    ).toEqual({ canSkip: false, reason: "round-robin-disabled" });
  });

  it("re-enables the skip once a second battle becomes ready", () => {
    const before = buildQueueRows([ready("current"), makeSource({ id: "other", orderKey: 1 })]);
    expect(queueSkipAvailability(before, { ...cycle, currentKey: keyFor("current") })).toEqual({
      canSkip: false,
      reason: "nothing-else-ready",
    });

    const after = buildQueueRows([ready("current"), ready("other", { orderKey: 1 })]);
    expect(queueSkipAvailability(after, { ...cycle, currentKey: keyFor("current") })).toEqual({
      canSkip: true,
    });
  });

  it("counts eligibility across environments", () => {
    const rows = buildQueueRows([
      ready("local"),
      ready("remote", { environmentId: REMOTE, orderKey: 1 }),
    ]);
    // The merged view is one lap, so a ready battle on another machine is
    // somewhere to go.
    expect(eligibleQueueRows(rows, cycle)).toHaveLength(2);
    expect(queueSkipAvailability(rows, { ...cycle, currentKey: keyFor("local") })).toEqual({
      canSkip: true,
    });
  });
});
