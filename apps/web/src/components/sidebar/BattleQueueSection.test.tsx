import type { QueueRow } from "@t3tools/client-runtime/state/battle-queue";
import type { BattleId, EnvironmentId, ProjectId, QueueAction } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { BattleQueueSection } from "./BattleQueueSection";

const action = (id: string, outcome: QueueAction["outcome"]): QueueAction =>
  ({
    id,
    threadIds: [],
    wakeRule: { kind: "all" },
    outcome,
    startedAt: "2026-01-01T00:00:00.000Z",
    readyAt: outcome === null ? null : "2026-01-01T00:01:00.000Z",
  }) as unknown as QueueAction;

function row(overrides: Partial<QueueRow> & Pick<QueueRow, "key" | "battleTitle">): QueueRow {
  return {
    environmentId: "env" as EnvironmentId,
    environmentLabel: "macbook",
    battleId: overrides.key as unknown as BattleId,
    projectId: "project" as ProjectId,
    projectTitle: "t3code",
    compoundedPriority: 0,
    state: "ready",
    hasErrored: false,
    readyActions: [],
    pendingActions: [],
    skippedInLap: false,
    ...overrides,
  } as QueueRow;
}

const noop = () => {};

function render(rows: ReadonlyArray<QueueRow>, next: QueueRow | null, showLabels = false): string {
  return renderToStaticMarkup(
    <BattleQueueSection
      rows={rows}
      next={next}
      showEnvironmentLabels={showLabels}
      onOpen={noop}
      onRemove={noop}
      onClearQueue={noop}
    />,
  );
}

describe("BattleQueueSection", () => {
  it("shows the next-up battle alone and puts the rest behind the shelf", () => {
    const next = row({ key: "a", battleTitle: "Queue frontend" });
    const rest = row({ key: "b", battleTitle: "Push notifications" });
    const markup = render([next, rest], next);
    expect(markup).toContain("Queue frontend");
    // Collapsed: the second battle is only named by the shelf count.
    expect(markup).not.toContain("Push notifications");
    expect(markup).toContain("Show more (1)");
  });

  it("falls back to the first three rows when nothing is ready", () => {
    const rows = ["a", "b", "c", "d"].map((key) =>
      row({
        key,
        battleTitle: `Battle ${key}`,
        state: "busy",
        pendingActions: [action(key, null)],
      }),
    );
    const markup = render(rows, null);
    expect(markup).toContain("Battle a");
    expect(markup).toContain("Battle c");
    expect(markup).not.toContain("Battle d");
    expect(markup).toContain("Show more (1)");
    // Nothing is ready, so nothing claims the Next slot's emphasis.
    expect(markup).not.toContain("ring-ring/45");
  });

  it("marks an errored row when it is on screen", () => {
    const errored = row({
      key: "a",
      battleTitle: "Flaky tests",
      hasErrored: true,
      readyActions: [action("x", "errored")],
    });
    expect(render([errored], errored)).toContain("An action errored");
  });

  it("never promotes an errored row out of its tier", () => {
    const first = row({ key: "a", battleTitle: "First" });
    const errored = row({
      key: "b",
      battleTitle: "Flaky tests",
      hasErrored: true,
      readyActions: [action("x", "errored")],
    });
    // Second in the order stays second: erroring is marked, never ranked.
    const markup = render([first, errored], first);
    expect(markup).toContain("First");
    expect(markup).not.toContain("Flaky tests");
    expect(markup).toContain("Show more (1)");
  });

  it("counts only ready rows in the header", () => {
    const ready = row({ key: "a", battleTitle: "Ready one" });
    const busy = row({ key: "b", battleTitle: "Busy one", state: "busy" });
    const notStarted = row({ key: "c", battleTitle: "Fresh", state: "not-started" });
    expect(render([ready, busy, notStarted], ready)).toContain("1 ready");
  });

  it("labels the environment only when asked", () => {
    const only = row({ key: "a", battleTitle: "Solo" });
    expect(render([only], only)).not.toContain("macbook");
    expect(render([only], only, true)).toContain("macbook");
  });

  it("says what to do when the queue is empty", () => {
    expect(render([], null)).toContain("Nothing queued");
  });
});
