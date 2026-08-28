import {
  BattleId,
  BattleThreadGroupId,
  CommandId,
  DEFAULT_QUEUE_WAKE_RULE,
  ProjectId,
  ProviderInstanceId,
  QueueActionId,
  ThreadId,
  VictoryConditionId,
  type BattleQueueEntry,
  type OrchestrationBattle,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type QueueAction,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const PROJECT_ID = ProjectId.make("project-1");
const BATTLE_ID = BattleId.make("battle-1");
const OTHER_BATTLE_ID = BattleId.make("battle-2");
const ACTION_ID = QueueActionId.make("action-1");
const THREAD_ID = ThreadId.make("thread-1");
const MATE_THREAD_ID = ThreadId.make("thread-2");

function makeBattle(input: Partial<OrchestrationBattle> = {}): OrchestrationBattle {
  return {
    id: input.id ?? BATTLE_ID,
    projectId: PROJECT_ID,
    title: input.title ?? "Ship the thing",
    goal: null,
    slug: "ship-the-thing",
    phase: input.phase ?? "scoping",
    victoryConditions: input.victoryConditions ?? [],
    orchestratorThreadId: null,
    ...(input.priority === undefined ? {} : { priority: input.priority }),
    ...(input.threadGroups === undefined ? {} : { threadGroups: input.threadGroups }),
    defeatedAt: input.defeatedAt ?? null,
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: input.deletedAt ?? null,
  };
}

function makeAction(input: Partial<QueueAction> = {}): QueueAction {
  return {
    id: input.id ?? ACTION_ID,
    threadIds: input.threadIds ?? [THREAD_ID],
    wakeRule: input.wakeRule ?? DEFAULT_QUEUE_WAKE_RULE,
    outcome: input.outcome ?? null,
    startedAt: NOW,
    readyAt: input.readyAt ?? null,
  };
}

function makeEntry(input: Partial<BattleQueueEntry> = {}): BattleQueueEntry {
  return {
    battleId: input.battleId ?? BATTLE_ID,
    projectId: PROJECT_ID,
    orderKey: input.orderKey ?? 0,
    skippedInLap: input.skippedInLap ?? false,
    actions: input.actions ?? [],
    addedAt: NOW,
    updatedAt: NOW,
  };
}

function makeThread(threadId: ThreadId, battleId: BattleId | null) {
  return {
    id: threadId,
    projectId: PROJECT_ID,
    battleId,
    title: "Thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access" as const,
    interactionMode: "default" as const,
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    pinnedAt: null,
    pinOrderKey: null,
    deletedAt: null,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: null,
  };
}

function makeReadModel(
  input: {
    readonly battles?: ReadonlyArray<OrchestrationBattle>;
    readonly queueEntries?: ReadonlyArray<BattleQueueEntry>;
    readonly threads?: ReadonlyArray<ReturnType<typeof makeThread>>;
  } = {},
): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [
      {
        id: PROJECT_ID,
        title: "Project",
        workspaceRoot: "/tmp/project-1",
        defaultModelSelection: null,
        defaultThreadEnvMode: null,
        faviconPath: null,
        scripts: [],
        createdAt: NOW,
        updatedAt: NOW,
        deletedAt: null,
      },
    ],
    battles: input.battles ?? [makeBattle()],
    ...(input.queueEntries === undefined ? {} : { queueEntries: input.queueEntries }),
    threads: input.threads ?? [],
    updatedAt: NOW,
  };
}

/**
 * Distributive, so `type` still narrows `payload` the way it does on the event
 * union itself. A plain `Omit<OrchestrationEvent, "sequence">` collapses the
 * union and loses that correlation.
 */
type PlannedEvent<E = OrchestrationEvent> = E extends OrchestrationEvent
  ? Omit<E, "sequence">
  : never;

/**
 * Every decide call in this file reads as a list, so normalize once. The cast
 * is needed because `Array.isArray` does not narrow a `ReadonlyArray`; the
 * runtime shape is exactly this union either way.
 */
const decide = (command: OrchestrationCommand, readModel: OrchestrationReadModel) =>
  decideOrchestrationCommand({ command, readModel }).pipe(
    Effect.map(
      (decided) => (Array.isArray(decided) ? decided : [decided]) as ReadonlyArray<PlannedEvent>,
    ),
  );

const eventTypes = (events: ReadonlyArray<{ readonly type: string }>) =>
  events.map((event) => event.type);

it.layer(NodeServices.layer)("battle queue decider", (it) => {
  it.effect("adds a dormant entry, appended to the end of the queue", () =>
    Effect.gen(function* () {
      const events = yield* decide(
        {
          type: "battle.queue.add",
          commandId: CommandId.make("cmd-add"),
          battleId: BATTLE_ID,
          createdAt: NOW,
        },
        makeReadModel({
          queueEntries: [makeEntry({ battleId: OTHER_BATTLE_ID, orderKey: 4 })],
          battles: [makeBattle(), makeBattle({ id: OTHER_BATTLE_ID })],
        }),
      );
      expect(eventTypes(events)).toEqual(["queue.entry-added"]);
      const [added] = events;
      if (added?.type !== "queue.entry-added") throw new Error("expected an add");
      expect(added.aggregateKind).toBe("queue");
      expect(added.aggregateId).toBe(BATTLE_ID);
      // Appended, so a tier reads back in the order you added to it.
      expect(added.payload.orderKey).toBe(5);
      expect(added.payload.projectId).toBe(PROJECT_ID);
    }),
  );

  it.effect("sets the battle's priority in the same breath as the add", () =>
    Effect.gen(function* () {
      const events = yield* decide(
        {
          type: "battle.queue.add",
          commandId: CommandId.make("cmd-add-priority"),
          battleId: BATTLE_ID,
          priority: 3,
          createdAt: NOW,
        },
        makeReadModel(),
      );
      expect(eventTypes(events)).toEqual(["battle.priority-set", "queue.entry-added"]);
    }),
  );

  it.effect("refuses to add a battle that is already queued", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        decide(
          {
            type: "battle.queue.add",
            commandId: CommandId.make("cmd-add-twice"),
            battleId: BATTLE_ID,
            createdAt: NOW,
          },
          makeReadModel({ queueEntries: [makeEntry()] }),
        ),
      );
      expect(result._tag).toBe("Failure");
    }),
  );

  it.effect("refuses to add a defeated battle", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        decide(
          {
            type: "battle.queue.add",
            commandId: CommandId.make("cmd-add-defeated"),
            battleId: BATTLE_ID,
            createdAt: NOW,
          },
          makeReadModel({ battles: [makeBattle({ phase: "defeated", defeatedAt: NOW })] }),
        ),
      );
      expect(result._tag).toBe("Failure");
    }),
  );

  it.effect("clears the rows it was given and skips ones already gone", () =>
    Effect.gen(function* () {
      const events = yield* decide(
        {
          type: "battle.queue.remove",
          commandId: CommandId.make("cmd-remove"),
          battleIds: [BATTLE_ID, OTHER_BATTLE_ID],
        },
        makeReadModel({ queueEntries: [makeEntry()] }),
      );
      // A select-all clear races an auto-drop, so an already-gone row is
      // skipped rather than failing the whole batch.
      expect(eventTypes(events)).toEqual(["queue.entry-removed"]);
      const [removed] = events;
      if (removed?.type !== "queue.entry-removed") throw new Error("expected a removal");
      expect(removed.payload.battleId).toBe(BATTLE_ID);
      expect(removed.payload.reason).toBe("manual");
    }),
  );

  it.effect("drops the row when the battle is declared defeated", () =>
    Effect.gen(function* () {
      const events = yield* decide(
        {
          type: "battle.declare-defeat",
          commandId: CommandId.make("cmd-defeat"),
          battleId: BATTLE_ID,
          retireWorktrees: false,
        },
        makeReadModel({
          battles: [
            makeBattle({
              phase: "fighting",
              victoryConditions: [
                {
                  id: VictoryConditionId.make("condition-1"),
                  title: "Ship it",
                  state: "scoped",
                  sizeScore: null,
                  sizeProvisional: false,
                  ownerThreadId: null,
                  strikeReason: null,
                  updatedByThreadId: null,
                  createdAt: NOW,
                  updatedAt: NOW,
                },
              ],
            }),
          ],
          queueEntries: [makeEntry()],
        }),
      );
      expect(eventTypes(events)).toEqual(["battle.phase-changed", "queue.entry-removed"]);
      const removed = events[1];
      if (removed?.type !== "queue.entry-removed") throw new Error("expected a removal");
      expect(removed.payload.reason).toBe("defeated");
    }),
  );

  it.effect("drops the row when the battle is deleted", () =>
    Effect.gen(function* () {
      const events = yield* decide(
        {
          type: "battle.delete",
          commandId: CommandId.make("cmd-delete"),
          battleId: BATTLE_ID,
        },
        makeReadModel({ queueEntries: [makeEntry()] }),
      );
      expect(eventTypes(events)).toEqual(["battle.deleted", "queue.entry-removed"]);
      const removed = events[1];
      if (removed?.type !== "queue.entry-removed") throw new Error("expected a removal");
      expect(removed.payload.reason).toBe("deleted");
    }),
  );

  it.effect("leaves an unqueued battle's defeat as a single event", () =>
    Effect.gen(function* () {
      const events = yield* decide(
        {
          type: "battle.delete",
          commandId: CommandId.make("cmd-delete-unqueued"),
          battleId: BATTLE_ID,
        },
        makeReadModel(),
      );
      expect(eventTypes(events)).toEqual(["battle.deleted"]);
    }),
  );

  it.effect("skips a row without ending the lap while another is still offerable", () =>
    Effect.gen(function* () {
      const events = yield* decide(
        {
          type: "battle.queue.skip",
          commandId: CommandId.make("cmd-skip"),
          battleId: BATTLE_ID,
        },
        makeReadModel({
          battles: [makeBattle(), makeBattle({ id: OTHER_BATTLE_ID })],
          queueEntries: [
            makeEntry({ actions: [makeAction({ outcome: "completed" })] }),
            makeEntry({
              battleId: OTHER_BATTLE_ID,
              orderKey: 1,
              actions: [makeAction({ id: QueueActionId.make("action-2"), outcome: "completed" })],
            }),
          ],
        }),
      );
      expect(eventTypes(events)).toEqual(["queue.entry-skipped"]);
    }),
  );

  it.effect("resets the lap on the skip that exhausts it", () =>
    Effect.gen(function* () {
      const events = yield* decide(
        {
          type: "battle.queue.skip",
          commandId: CommandId.make("cmd-skip-last"),
          battleId: BATTLE_ID,
        },
        makeReadModel({
          battles: [makeBattle(), makeBattle({ id: OTHER_BATTLE_ID })],
          queueEntries: [
            makeEntry({ actions: [makeAction({ outcome: "completed" })] }),
            // Already passed over, so skipping the last ready row ends the lap.
            makeEntry({
              battleId: OTHER_BATTLE_ID,
              orderKey: 1,
              skippedInLap: true,
              actions: [makeAction({ id: QueueActionId.make("action-2"), outcome: "completed" })],
            }),
          ],
        }),
      );
      expect(eventTypes(events)).toEqual(["queue.entry-skipped", "queue.lap-reset"]);
      const reset = events[1];
      if (reset?.type !== "queue.lap-reset") throw new Error("expected a lap reset");
      // Lap state is queue-wide, so it files under the queue rather than a battle.
      expect(reset.aggregateId).toBe("battle-queue");
    }),
  );

  it.effect("does not count a not-started battle as holding the lap open", () =>
    Effect.gen(function* () {
      const events = yield* decide(
        {
          type: "battle.queue.skip",
          commandId: CommandId.make("cmd-skip-not-started"),
          battleId: BATTLE_ID,
        },
        makeReadModel({
          battles: [makeBattle(), makeBattle({ id: OTHER_BATTLE_ID })],
          queueEntries: [
            makeEntry({ actions: [makeAction({ outcome: "completed" })] }),
            // Dormant: nothing to cycle to, so it neither holds the lap open
            // nor gets skipped out of it.
            makeEntry({ battleId: OTHER_BATTLE_ID, orderKey: 1 }),
          ],
        }),
      );
      expect(eventTypes(events)).toEqual(["queue.entry-skipped", "queue.lap-reset"]);
    }),
  );

  it.effect("re-offers the only ready battle, because skipping it ends the lap", () =>
    Effect.gen(function* () {
      const events = yield* decide(
        {
          type: "battle.queue.skip",
          commandId: CommandId.make("cmd-skip-only"),
          battleId: BATTLE_ID,
        },
        makeReadModel({
          queueEntries: [makeEntry({ actions: [makeAction({ outcome: "completed" })] })],
        }),
      );
      // The degenerate lap. With one eligible battle, passing it over is also
      // the pass that offers every eligible battle once, so the lap ends and
      // the skip is cleared in the same breath. There is nowhere else to go,
      // and leaving the queue with nothing offerable would be worse.
      expect(eventTypes(events)).toEqual(["queue.entry-skipped", "queue.lap-reset"]);
    }),
  );

  it.effect("refuses to skip the same battle twice in one lap", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        decide(
          {
            type: "battle.queue.skip",
            commandId: CommandId.make("cmd-skip-twice"),
            battleId: BATTLE_ID,
          },
          makeReadModel({ queueEntries: [makeEntry({ skippedInLap: true })] }),
        ),
      );
      expect(result._tag).toBe("Failure");
    }),
  );

  it.effect("opens an action for a queued battle", () =>
    Effect.gen(function* () {
      const events = yield* decide(
        {
          type: "battle.queue.action.start",
          commandId: CommandId.make("cmd-action-start"),
          battleId: BATTLE_ID,
          actionId: ACTION_ID,
          threadIds: [THREAD_ID],
          wakeRule: DEFAULT_QUEUE_WAKE_RULE,
          createdAt: NOW,
        },
        makeReadModel({ queueEntries: [makeEntry()] }),
      );
      expect(eventTypes(events)).toEqual(["queue.action-started"]);
    }),
  );

  it.effect("refuses to widen an action that already settled", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        decide(
          {
            type: "battle.queue.action.start",
            commandId: CommandId.make("cmd-action-restart"),
            battleId: BATTLE_ID,
            actionId: ACTION_ID,
            threadIds: [MATE_THREAD_ID],
            wakeRule: DEFAULT_QUEUE_WAKE_RULE,
            createdAt: NOW,
          },
          makeReadModel({
            queueEntries: [
              makeEntry({ actions: [makeAction({ outcome: "completed", readyAt: NOW })] }),
            ],
          }),
        ),
      );
      expect(result._tag).toBe("Failure");
    }),
  );

  it.effect("refuses an action that names no threads", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        decide(
          {
            type: "battle.queue.action.start",
            commandId: CommandId.make("cmd-action-empty"),
            battleId: BATTLE_ID,
            actionId: ACTION_ID,
            threadIds: [],
            wakeRule: DEFAULT_QUEUE_WAKE_RULE,
            createdAt: NOW,
          },
          makeReadModel({ queueEntries: [makeEntry()] }),
        ),
      );
      expect(result._tag).toBe("Failure");
    }),
  );

  it.effect("settles an open action exactly once", () =>
    Effect.gen(function* () {
      const readModel = makeReadModel({ queueEntries: [makeEntry({ actions: [makeAction()] })] });
      const events = yield* decide(
        {
          type: "battle.queue.action.settle",
          commandId: CommandId.make("cmd-action-settle"),
          battleId: BATTLE_ID,
          actionId: ACTION_ID,
          outcome: "needs-clarification",
        },
        readModel,
      );
      expect(eventTypes(events)).toEqual(["queue.action-settled"]);

      // The reactor sees several settle signals around one turn end; the
      // repeats are refused so one kick-off makes one wake.
      const repeat = yield* Effect.result(
        decide(
          {
            type: "battle.queue.action.settle",
            commandId: CommandId.make("cmd-action-settle-again"),
            battleId: BATTLE_ID,
            actionId: ACTION_ID,
            outcome: "completed",
          },
          makeReadModel({
            queueEntries: [
              makeEntry({
                actions: [makeAction({ outcome: "needs-clarification", readyAt: NOW })],
              }),
            ],
          }),
        ),
      );
      expect(repeat._tag).toBe("Failure");
    }),
  );

  it.effect("refuses a wake rule naming a thread outside the action", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        decide(
          {
            type: "battle.queue.action.wake-rule.set",
            commandId: CommandId.make("cmd-wake-foreign"),
            battleId: BATTLE_ID,
            actionId: ACTION_ID,
            wakeRule: { kind: "thread", threadId: MATE_THREAD_ID },
          },
          makeReadModel({
            queueEntries: [makeEntry({ actions: [makeAction({ threadIds: [THREAD_ID] })] })],
          }),
        ),
      );
      expect(result._tag).toBe("Failure");
    }),
  );

  it.effect("accepts a wake rule naming a thread the action holds", () =>
    Effect.gen(function* () {
      const events = yield* decide(
        {
          type: "battle.queue.action.wake-rule.set",
          commandId: CommandId.make("cmd-wake-any"),
          battleId: BATTLE_ID,
          actionId: ACTION_ID,
          wakeRule: { kind: "thread", threadId: MATE_THREAD_ID },
        },
        makeReadModel({
          queueEntries: [
            makeEntry({ actions: [makeAction({ threadIds: [THREAD_ID, MATE_THREAD_ID] })] }),
          ],
        }),
      );
      expect(eventTypes(events)).toEqual(["queue.action-wake-rule-set"]);
    }),
  );

  it.effect("refuses a new wake rule on a settled action", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        decide(
          {
            type: "battle.queue.action.wake-rule.set",
            commandId: CommandId.make("cmd-wake-settled"),
            battleId: BATTLE_ID,
            actionId: ACTION_ID,
            wakeRule: { kind: "any" },
          },
          makeReadModel({
            queueEntries: [
              makeEntry({ actions: [makeAction({ outcome: "completed", readyAt: NOW })] }),
            ],
          }),
        ),
      );
      expect(result._tag).toBe("Failure");
    }),
  );

  it.effect("refuses every action command for a battle that is not queued", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        decide(
          {
            type: "battle.queue.action.clear",
            commandId: CommandId.make("cmd-clear-unqueued"),
            battleId: BATTLE_ID,
            actionId: ACTION_ID,
          },
          makeReadModel(),
        ),
      );
      expect(result._tag).toBe("Failure");
    }),
  );

  it.effect("stores only the groups that hold more than one thread", () =>
    Effect.gen(function* () {
      const events = yield* decide(
        {
          type: "battle.thread-groups.set",
          commandId: CommandId.make("cmd-groups"),
          battleId: BATTLE_ID,
          groups: [
            { id: BattleThreadGroupId.make("group-1"), threadIds: [THREAD_ID, MATE_THREAD_ID] },
            // A thread no group names is already in a group of its own, so a
            // stored singleton would be a second way to say the same thing.
            { id: BattleThreadGroupId.make("group-2"), threadIds: [ThreadId.make("thread-3")] },
          ],
        },
        makeReadModel({
          threads: [
            makeThread(THREAD_ID, BATTLE_ID),
            makeThread(MATE_THREAD_ID, BATTLE_ID),
            makeThread(ThreadId.make("thread-3"), BATTLE_ID),
          ],
        }),
      );
      const [set] = events;
      if (set?.type !== "battle.thread-groups-set") throw new Error("expected a grouping");
      expect(set.payload.groups).toHaveLength(1);
      expect(set.payload.groups[0]?.threadIds).toEqual([THREAD_ID, MATE_THREAD_ID]);
    }),
  );

  it.effect("refuses a grouping that names a thread outside the battle", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        decide(
          {
            type: "battle.thread-groups.set",
            commandId: CommandId.make("cmd-groups-foreign"),
            battleId: BATTLE_ID,
            groups: [
              { id: BattleThreadGroupId.make("group-1"), threadIds: [THREAD_ID, MATE_THREAD_ID] },
            ],
          },
          makeReadModel({ threads: [makeThread(THREAD_ID, BATTLE_ID)] }),
        ),
      );
      expect(result._tag).toBe("Failure");
    }),
  );

  it.effect("refuses a grouping that puts one thread in two groups", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        decide(
          {
            type: "battle.thread-groups.set",
            commandId: CommandId.make("cmd-groups-duplicate"),
            battleId: BATTLE_ID,
            groups: [
              { id: BattleThreadGroupId.make("group-1"), threadIds: [THREAD_ID, MATE_THREAD_ID] },
              {
                id: BattleThreadGroupId.make("group-2"),
                threadIds: [THREAD_ID, ThreadId.make("thread-3")],
              },
            ],
          },
          makeReadModel({
            threads: [
              makeThread(THREAD_ID, BATTLE_ID),
              makeThread(MATE_THREAD_ID, BATTLE_ID),
              makeThread(ThreadId.make("thread-3"), BATTLE_ID),
            ],
          }),
        ),
      );
      expect(result._tag).toBe("Failure");
    }),
  );

  it.effect("records project and battle priority against their own aggregates", () =>
    Effect.gen(function* () {
      const projectEvents = yield* decide(
        {
          type: "project.priority.set",
          commandId: CommandId.make("cmd-project-priority"),
          projectId: PROJECT_ID,
          priority: 2,
        },
        makeReadModel(),
      );
      const [projectSet] = projectEvents;
      if (projectSet?.type !== "project.priority-set") throw new Error("expected a project set");
      expect(projectSet.aggregateKind).toBe("project");
      expect(projectSet.payload.priority).toBe(2);

      const battleEvents = yield* decide(
        {
          type: "battle.priority.set",
          commandId: CommandId.make("cmd-battle-priority"),
          battleId: BATTLE_ID,
          priority: 1,
        },
        makeReadModel(),
      );
      const [battleSet] = battleEvents;
      if (battleSet?.type !== "battle.priority-set") throw new Error("expected a battle set");
      expect(battleSet.aggregateKind).toBe("battle");
      expect(battleSet.payload.priority).toBe(1);
    }),
  );
});
