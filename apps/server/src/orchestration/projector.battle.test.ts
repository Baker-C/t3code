import {
  BattleId,
  CommandId,
  EventId,
  ProjectId,
  ThreadId,
  VictoryConditionId,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { createEmptyReadModel, projectEvent } from "./projector.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const LATER = "2026-01-02T00:00:00.000Z";
const BATTLE_ID = BattleId.make("battle-1");
const PROJECT_ID = ProjectId.make("project-1");
const THREAD_ID = ThreadId.make("thread-1");
const CONDITION_ID = VictoryConditionId.make("condition-1");

function makeEvent(input: {
  readonly sequence: number;
  readonly type: OrchestrationEvent["type"];
  readonly aggregateKind: OrchestrationEvent["aggregateKind"];
  readonly aggregateId: OrchestrationEvent["aggregateId"];
  readonly payload: unknown;
}): OrchestrationEvent {
  return {
    sequence: input.sequence,
    eventId: EventId.make(`event-${input.sequence}`),
    type: input.type,
    aggregateKind: input.aggregateKind,
    aggregateId: input.aggregateId,
    occurredAt: NOW,
    commandId: CommandId.make(`command-${input.sequence}`),
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload: input.payload as never,
  } as OrchestrationEvent;
}

const battleEvent = (
  sequence: number,
  type: OrchestrationEvent["type"],
  payload: unknown,
): OrchestrationEvent =>
  makeEvent({ sequence, type, aggregateKind: "battle", aggregateId: BATTLE_ID, payload });

const createdBattle = battleEvent(1, "battle.created", {
  battleId: BATTLE_ID,
  projectId: PROJECT_ID,
  title: "Ship the thing",
  goal: null,
  slug: "ship-the-thing",
  createdAt: NOW,
  updatedAt: NOW,
});

it.effect("projects a created battle into the read model as scoping", () =>
  Effect.gen(function* () {
    const model = yield* projectEvent(createEmptyReadModel(NOW), createdBattle);
    expect(model.battles).toHaveLength(1);
    expect(model.battles[0]?.id).toBe(BATTLE_ID);
    expect(model.battles[0]?.phase).toBe("scoping");
    expect(model.battles[0]?.slug).toBe("ship-the-thing");
    expect(model.battles[0]?.victoryConditions).toEqual([]);
    expect(model.battles[0]?.deletedAt).toBeNull();
  }),
);

it.effect("projects battle metadata updates without touching untouched fields", () =>
  Effect.gen(function* () {
    const created = yield* projectEvent(createEmptyReadModel(NOW), createdBattle);
    const updated = yield* projectEvent(
      created,
      battleEvent(2, "battle.meta-updated", {
        battleId: BATTLE_ID,
        goal: "Land the battle feature",
        updatedAt: LATER,
      }),
    );
    expect(updated.battles[0]?.title).toBe("Ship the thing");
    expect(updated.battles[0]?.goal).toBe("Land the battle feature");
    expect(updated.battles[0]?.slug).toBe("ship-the-thing");
    expect(updated.battles[0]?.updatedAt).toBe(LATER);
  }),
);

it.effect("projects the victory condition lifecycle", () =>
  Effect.gen(function* () {
    const created = yield* projectEvent(createEmptyReadModel(NOW), createdBattle);

    const added = yield* projectEvent(
      created,
      battleEvent(2, "battle.condition-added", {
        battleId: BATTLE_ID,
        condition: {
          id: CONDITION_ID,
          title: "Sidebar renders battles",
          state: "unscoped",
          sizeScore: null,
          sizeProvisional: false,
          ownerThreadId: null,
          strikeReason: null,
          updatedByThreadId: null,
          createdAt: NOW,
          updatedAt: NOW,
        },
        updatedAt: NOW,
      }),
    );
    expect(added.battles[0]?.victoryConditions).toHaveLength(1);
    expect(added.battles[0]?.victoryConditions[0]?.state).toBe("unscoped");

    const scoped = yield* projectEvent(
      added,
      battleEvent(3, "battle.condition-updated", {
        battleId: BATTLE_ID,
        conditionId: CONDITION_ID,
        state: "scoped",
        sizeScore: 3,
        updatedByThreadId: THREAD_ID,
        updatedAt: LATER,
      }),
    );
    expect(scoped.battles[0]?.victoryConditions[0]?.state).toBe("scoped");
    expect(scoped.battles[0]?.victoryConditions[0]?.sizeScore).toBe(3);
    expect(scoped.battles[0]?.victoryConditions[0]?.updatedByThreadId).toBe(THREAD_ID);
    expect(scoped.battles[0]?.victoryConditions[0]?.title).toBe("Sidebar renders battles");

    const struck = yield* projectEvent(
      scoped,
      battleEvent(4, "battle.condition-struck", {
        battleId: BATTLE_ID,
        conditionId: CONDITION_ID,
        strikeReason: "Covered by another battle",
        updatedByThreadId: null,
        updatedAt: LATER,
      }),
    );
    // A struck condition is descoped, not removed: the record keeps the why.
    expect(struck.battles[0]?.victoryConditions).toHaveLength(1);
    expect(struck.battles[0]?.victoryConditions[0]?.state).toBe("descoped");
    expect(struck.battles[0]?.victoryConditions[0]?.strikeReason).toBe("Covered by another battle");
  }),
);

it.effect("projects phase changes and the deletion tombstone", () =>
  Effect.gen(function* () {
    const created = yield* projectEvent(createEmptyReadModel(NOW), createdBattle);

    const fighting = yield* projectEvent(
      created,
      battleEvent(2, "battle.phase-changed", {
        battleId: BATTLE_ID,
        phase: "fighting",
        retireWorktrees: null,
        defeatedAt: null,
        updatedAt: LATER,
      }),
    );
    expect(fighting.battles[0]?.phase).toBe("fighting");

    const defeated = yield* projectEvent(
      fighting,
      battleEvent(3, "battle.phase-changed", {
        battleId: BATTLE_ID,
        phase: "defeated",
        retireWorktrees: true,
        defeatedAt: LATER,
        updatedAt: LATER,
      }),
    );
    expect(defeated.battles[0]?.phase).toBe("defeated");
    expect(defeated.battles[0]?.defeatedAt).toBe(LATER);

    const reopened = yield* projectEvent(
      defeated,
      battleEvent(4, "battle.phase-changed", {
        battleId: BATTLE_ID,
        phase: "fighting",
        retireWorktrees: null,
        defeatedAt: null,
        updatedAt: LATER,
      }),
    );
    expect(reopened.battles[0]?.phase).toBe("fighting");
    expect(reopened.battles[0]?.defeatedAt).toBeNull();

    const deleted = yield* projectEvent(
      reopened,
      battleEvent(5, "battle.deleted", {
        battleId: BATTLE_ID,
        deletedAt: LATER,
      }),
    );
    expect(deleted.battles[0]?.deletedAt).toBe(LATER);
  }),
);

it.effect("projects a thread's battle membership and queued-turn flag", () =>
  Effect.gen(function* () {
    const created = yield* projectEvent(
      createEmptyReadModel(NOW),
      makeEvent({
        sequence: 1,
        type: "thread.created",
        aggregateKind: "thread",
        aggregateId: THREAD_ID,
        payload: {
          threadId: THREAD_ID,
          projectId: PROJECT_ID,
          battleId: BATTLE_ID,
          title: "Thread",
          modelSelection: { provider: "codex", model: "gpt-5.4" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: NOW,
          updatedAt: NOW,
        },
      }),
    );
    expect(created.threads[0]?.battleId).toBe(BATTLE_ID);
    expect(created.threads[0]?.turnQueued ?? false).toBe(false);

    const queued = yield* projectEvent(
      created,
      makeEvent({
        sequence: 2,
        type: "thread.turn-queue-updated",
        aggregateKind: "thread",
        aggregateId: THREAD_ID,
        payload: { threadId: THREAD_ID, turnQueued: true, updatedAt: LATER },
      }),
    );
    expect(queued.threads[0]?.turnQueued).toBe(true);
    expect(queued.threads[0]?.battleId).toBe(BATTLE_ID);

    const cleared = yield* projectEvent(
      queued,
      makeEvent({
        sequence: 3,
        type: "thread.turn-queue-updated",
        aggregateKind: "thread",
        aggregateId: THREAD_ID,
        payload: { threadId: THREAD_ID, turnQueued: false, updatedAt: LATER },
      }),
    );
    expect(cleared.threads[0]?.turnQueued).toBe(false);
  }),
);

it.effect("leaves battleId null for threads created outside a battle", () =>
  Effect.gen(function* () {
    const created = yield* projectEvent(
      createEmptyReadModel(NOW),
      makeEvent({
        sequence: 1,
        type: "thread.created",
        aggregateKind: "thread",
        aggregateId: THREAD_ID,
        payload: {
          threadId: THREAD_ID,
          projectId: PROJECT_ID,
          title: "Thread",
          modelSelection: { provider: "codex", model: "gpt-5.4" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: NOW,
          updatedAt: NOW,
        },
      }),
    );
    expect(created.threads[0]?.battleId ?? null).toBeNull();
  }),
);
