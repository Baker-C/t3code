import {
  BattleId,
  BattleThreadGroupId,
  CommandId,
  DEFAULT_QUEUE_WAKE_RULE,
  EventId,
  ProjectId,
  QueueActionId,
  ThreadId,
  resolveQueueEntries,
  type OrchestrationEvent,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import { describe } from "vite-plus/test";
import * as Effect from "effect/Effect";

import { createEmptyReadModel, projectEvent } from "./projector.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const PROJECT_ID = ProjectId.make("project-1");
const BATTLE_ID = BattleId.make("battle-1");
const OTHER_BATTLE_ID = BattleId.make("battle-2");
const ACTION_ID = QueueActionId.make("action-1");
const OTHER_ACTION_ID = QueueActionId.make("action-2");
const THREAD_ID = ThreadId.make("thread-1");
const MATE_THREAD_ID = ThreadId.make("thread-2");

let sequence = 0;

function event<T extends OrchestrationEvent["type"]>(
  type: T,
  payload: Extract<OrchestrationEvent, { type: T }>["payload"],
): OrchestrationEvent {
  sequence += 1;
  return {
    sequence,
    eventId: EventId.make(`event-${sequence}`),
    aggregateKind: "queue",
    aggregateId: BATTLE_ID,
    occurredAt: NOW,
    commandId: CommandId.make(`cmd-${sequence}`),
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type,
    payload,
  } as OrchestrationEvent;
}

/** Folds a list of events over an empty read model, the way the engine does. */
const project = Effect.fn("project")(function* (events: ReadonlyArray<OrchestrationEvent>) {
  let model = createEmptyReadModel(NOW);
  for (const next of events) {
    model = yield* projectEvent(model, next);
  }
  return model;
});

const entriesOf = (model: OrchestrationReadModel) => resolveQueueEntries(model.queueEntries);

const addEntry = (battleId: BattleId = BATTLE_ID, orderKey = 0) =>
  event("queue.entry-added", { battleId, projectId: PROJECT_ID, orderKey, addedAt: NOW });

const startAction = (
  actionId: QueueActionId = ACTION_ID,
  threadIds: ReadonlyArray<ThreadId> = [THREAD_ID],
) =>
  event("queue.action-started", {
    battleId: BATTLE_ID,
    actionId,
    threadIds,
    wakeRule: DEFAULT_QUEUE_WAKE_RULE,
    startedAt: NOW,
  });

describe("battle queue projector", () => {
  it.effect("adds a dormant entry", () =>
    Effect.gen(function* () {
      const model = yield* project([addEntry()]);
      const entries = entriesOf(model);
      expect(entries).toHaveLength(1);
      expect(entries[0]?.battleId).toBe(BATTLE_ID);
      // The slot is the intent; an action is the concrete work that follows.
      expect(entries[0]?.actions).toEqual([]);
      expect(entries[0]?.skippedInLap).toBe(false);
    }),
  );

  it.effect("removes an entry outright rather than tombstoning it", () =>
    Effect.gen(function* () {
      const model = yield* project([
        addEntry(),
        event("queue.entry-removed", { battleId: BATTLE_ID, reason: "manual", removedAt: NOW }),
      ]);
      expect(entriesOf(model)).toEqual([]);
    }),
  );

  it.effect("widens an open action instead of opening a rival one", () =>
    Effect.gen(function* () {
      const model = yield* project([
        addEntry(),
        startAction(),
        startAction(ACTION_ID, [MATE_THREAD_ID]),
      ]);
      const [entry] = entriesOf(model);
      // One hand-off makes one row, however many threads join it.
      expect(entry?.actions).toHaveLength(1);
      expect(entry?.actions[0]?.threadIds).toEqual([THREAD_ID, MATE_THREAD_ID]);
    }),
  );

  it.effect("does not duplicate a thread the action already holds", () =>
    Effect.gen(function* () {
      const model = yield* project([
        addEntry(),
        startAction(),
        startAction(ACTION_ID, [THREAD_ID]),
      ]);
      expect(entriesOf(model)[0]?.actions[0]?.threadIds).toEqual([THREAD_ID]);
    }),
  );

  it.effect("records the outcome a wake rule settled with", () =>
    Effect.gen(function* () {
      const model = yield* project([
        addEntry(),
        startAction(),
        event("queue.action-settled", {
          battleId: BATTLE_ID,
          actionId: ACTION_ID,
          outcome: "errored",
          readyAt: NOW,
        }),
      ]);
      const action = entriesOf(model)[0]?.actions[0];
      expect(action?.outcome).toBe("errored");
      expect(action?.readyAt).toBe(NOW);
    }),
  );

  it.effect("clears a skip when fresh work in that battle wants you again", () =>
    Effect.gen(function* () {
      const model = yield* project([
        addEntry(),
        startAction(),
        event("queue.entry-skipped", { battleId: BATTLE_ID, skippedAt: NOW }),
        // New work is new information, so a passed-over battle earns its place
        // back in the lap rather than waiting for the lap to end.
        event("queue.action-settled", {
          battleId: BATTLE_ID,
          actionId: ACTION_ID,
          outcome: "completed",
          readyAt: NOW,
        }),
      ]);
      expect(entriesOf(model)[0]?.skippedInLap).toBe(false);
    }),
  );

  it.effect("clears every skip when the lap resets", () =>
    Effect.gen(function* () {
      const model = yield* project([
        addEntry(),
        addEntry(OTHER_BATTLE_ID, 1),
        event("queue.entry-skipped", { battleId: BATTLE_ID, skippedAt: NOW }),
        event("queue.entry-skipped", { battleId: OTHER_BATTLE_ID, skippedAt: NOW }),
        event("queue.lap-reset", { resetAt: NOW }),
      ]);
      expect(entriesOf(model).map((entry) => entry.skippedInLap)).toEqual([false, false]);
    }),
  );

  it.effect("drops only the action that was cleared", () =>
    Effect.gen(function* () {
      const model = yield* project([
        addEntry(),
        startAction(),
        startAction(OTHER_ACTION_ID, [MATE_THREAD_ID]),
        event("queue.action-cleared", {
          battleId: BATTLE_ID,
          actionId: ACTION_ID,
          clearedAt: NOW,
        }),
      ]);
      const [entry] = entriesOf(model);
      expect(entry?.actions).toHaveLength(1);
      expect(entry?.actions[0]?.id).toBe(OTHER_ACTION_ID);
    }),
  );

  it.effect("re-arms an open action with a new wake rule", () =>
    Effect.gen(function* () {
      const model = yield* project([
        addEntry(),
        startAction(ACTION_ID, [THREAD_ID, MATE_THREAD_ID]),
        event("queue.action-wake-rule-set", {
          battleId: BATTLE_ID,
          actionId: ACTION_ID,
          wakeRule: { kind: "thread", threadId: MATE_THREAD_ID },
          updatedAt: NOW,
        }),
      ]);
      expect(entriesOf(model)[0]?.actions[0]?.wakeRule).toEqual({
        kind: "thread",
        threadId: MATE_THREAD_ID,
      });
    }),
  );

  it.effect("ignores queue events for a battle that is not queued", () =>
    Effect.gen(function* () {
      const model = yield* project([startAction()]);
      expect(entriesOf(model)).toEqual([]);
    }),
  );

  it.effect("records project and battle priority on their own aggregates", () =>
    Effect.gen(function* () {
      const model = yield* project([
        event("project.created", {
          projectId: PROJECT_ID,
          title: "Project",
          workspaceRoot: "/tmp/project-1",
          defaultModelSelection: null,
          faviconPath: null,
          scripts: [],
          createdAt: NOW,
          updatedAt: NOW,
        }),
        event("battle.created", {
          battleId: BATTLE_ID,
          projectId: PROJECT_ID,
          title: "Ship it",
          goal: null,
          slug: "ship-it",
          createdAt: NOW,
          updatedAt: NOW,
        }),
        event("project.priority-set", { projectId: PROJECT_ID, priority: 2, updatedAt: NOW }),
        event("battle.priority-set", { battleId: BATTLE_ID, priority: 3, updatedAt: NOW }),
        event("battle.thread-groups-set", {
          battleId: BATTLE_ID,
          groups: [
            { id: BattleThreadGroupId.make("group-1"), threadIds: [THREAD_ID, MATE_THREAD_ID] },
          ],
          updatedAt: NOW,
        }),
      ]);
      expect(model.projects[0]?.priority).toBe(2);
      expect(model.battles[0]?.priority).toBe(3);
      expect(model.battles[0]?.threadGroups?.[0]?.threadIds).toEqual([THREAD_ID, MATE_THREAD_ID]);
    }),
  );
});
