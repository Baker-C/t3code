import {
  BattleId,
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  VictoryConditionId,
  type OrchestrationBattle,
  type OrchestrationReadModel,
  type VictoryCondition,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const PROJECT_ID = ProjectId.make("project-1");
const BATTLE_ID = BattleId.make("battle-1");

function makeCondition(
  input: Omit<Partial<VictoryCondition>, "id"> & { readonly id: string },
): VictoryCondition {
  return {
    id: VictoryConditionId.make(input.id),
    title: input.title ?? "Condition",
    state: input.state ?? "unscoped",
    sizeScore: input.sizeScore ?? null,
    sizeProvisional: input.sizeProvisional ?? false,
    ownerThreadId: input.ownerThreadId ?? null,
    strikeReason: input.strikeReason ?? null,
    updatedByThreadId: input.updatedByThreadId ?? null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function makeBattle(input: Partial<OrchestrationBattle> = {}): OrchestrationBattle {
  return {
    id: BATTLE_ID,
    projectId: PROJECT_ID,
    title: input.title ?? "Ship the thing",
    goal: input.goal ?? null,
    slug: input.slug ?? "ship-the-thing",
    phase: input.phase ?? "scoping",
    victoryConditions: input.victoryConditions ?? [],
    orchestratorThreadId: input.orchestratorThreadId ?? null,
    defeatedAt: input.defeatedAt ?? null,
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: input.deletedAt ?? null,
  };
}

function makeReadModel(
  input: {
    readonly battles?: ReadonlyArray<OrchestrationBattle>;
    readonly threadBattleId?: BattleId | null;
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
    battles: input.battles ?? [],
    threads:
      input.threadBattleId === undefined
        ? []
        : [
            {
              id: ThreadId.make("thread-1"),
              projectId: PROJECT_ID,
              battleId: input.threadBattleId,
              title: "Thread",
              modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
              runtimeMode: "full-access",
              interactionMode: "default",
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
            },
          ],
    updatedAt: NOW,
  };
}

it.layer(NodeServices.layer)("battle decider", (it) => {
  it.effect("creates a battle in the scoping phase with a slug derived from the title", () =>
    Effect.gen(function* () {
      const decided = yield* decideOrchestrationCommand({
        command: {
          type: "battle.create",
          commandId: CommandId.make("cmd-create"),
          battleId: BATTLE_ID,
          projectId: PROJECT_ID,
          title: "  Ship the Thing!! (v2)  ",
          createdAt: NOW,
        },
        readModel: makeReadModel(),
      });
      const events = Array.isArray(decided) ? decided : [decided];
      expect(events).toHaveLength(1);
      const event = events[0];
      expect(event?.type).toBe("battle.created");
      if (event?.type === "battle.created") {
        expect(event.aggregateKind).toBe("battle");
        expect(event.aggregateId).toBe(BATTLE_ID);
        expect(event.payload.slug).toBe("ship-the-thing-v2");
        expect(event.payload.goal).toBeNull();
      }
    }),
  );

  it.effect("falls back to a placeholder slug when the title has no usable characters", () =>
    Effect.gen(function* () {
      const decided = yield* decideOrchestrationCommand({
        command: {
          type: "battle.create",
          commandId: CommandId.make("cmd-create-symbols"),
          battleId: BATTLE_ID,
          projectId: PROJECT_ID,
          title: "!!! ???",
          createdAt: NOW,
        },
        readModel: makeReadModel(),
      });
      const event = Array.isArray(decided) ? decided[0] : decided;
      if (event?.type === "battle.created") {
        expect(event.payload.slug).toBe("battle");
      }
    }),
  );

  it.effect("rejects creating a battle whose project does not exist", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        decideOrchestrationCommand({
          command: {
            type: "battle.create",
            commandId: CommandId.make("cmd-create-missing-project"),
            battleId: BATTLE_ID,
            projectId: ProjectId.make("project-missing"),
            title: "Orphan",
            createdAt: NOW,
          },
          readModel: makeReadModel(),
        }),
      );
      expect(result._tag).toBe("Failure");
    }),
  );

  it.effect("rejects creating the same battle twice", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        decideOrchestrationCommand({
          command: {
            type: "battle.create",
            commandId: CommandId.make("cmd-create-dup"),
            battleId: BATTLE_ID,
            projectId: PROJECT_ID,
            title: "Ship the thing",
            createdAt: NOW,
          },
          readModel: makeReadModel({ battles: [makeBattle()] }),
        }),
      );
      expect(result._tag).toBe("Failure");
    }),
  );

  it.effect("adds a victory condition with defaults and carries agent attribution", () =>
    Effect.gen(function* () {
      const decided = yield* decideOrchestrationCommand({
        command: {
          type: "battle.condition.add",
          commandId: CommandId.make("cmd-condition-add"),
          battleId: BATTLE_ID,
          conditionId: VictoryConditionId.make("condition-1"),
          title: "Sidebar renders battles",
          updatedByThreadId: ThreadId.make("thread-1"),
        },
        readModel: makeReadModel({ battles: [makeBattle()] }),
      });
      const event = Array.isArray(decided) ? decided[0] : decided;
      expect(event?.type).toBe("battle.condition-added");
      if (event?.type === "battle.condition-added") {
        expect(event.payload.condition.state).toBe("unscoped");
        expect(event.payload.condition.sizeScore).toBeNull();
        expect(event.payload.condition.sizeProvisional).toBe(false);
        expect(event.payload.condition.strikeReason).toBeNull();
        expect(event.payload.condition.updatedByThreadId).toBe("thread-1");
      }
    }),
  );

  it.effect("rejects adding a condition id that already exists on the battle", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        decideOrchestrationCommand({
          command: {
            type: "battle.condition.add",
            commandId: CommandId.make("cmd-condition-add-dup"),
            battleId: BATTLE_ID,
            conditionId: VictoryConditionId.make("condition-1"),
            title: "Duplicate",
          },
          readModel: makeReadModel({
            battles: [makeBattle({ victoryConditions: [makeCondition({ id: "condition-1" })] })],
          }),
        }),
      );
      expect(result._tag).toBe("Failure");
    }),
  );

  it.effect("strikes a condition with its reason and attribution", () =>
    Effect.gen(function* () {
      const decided = yield* decideOrchestrationCommand({
        command: {
          type: "battle.condition.strike",
          commandId: CommandId.make("cmd-condition-strike"),
          battleId: BATTLE_ID,
          conditionId: VictoryConditionId.make("condition-1"),
          strikeReason: "Out of scope for v1",
        },
        readModel: makeReadModel({
          battles: [makeBattle({ victoryConditions: [makeCondition({ id: "condition-1" })] })],
        }),
      });
      const event = Array.isArray(decided) ? decided[0] : decided;
      expect(event?.type).toBe("battle.condition-struck");
      if (event?.type === "battle.condition-struck") {
        expect(event.payload.strikeReason).toBe("Out of scope for v1");
        expect(event.payload.updatedByThreadId).toBeNull();
      }
    }),
  );

  it.effect("rejects updating a condition that does not exist", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        decideOrchestrationCommand({
          command: {
            type: "battle.condition.update",
            commandId: CommandId.make("cmd-condition-update-missing"),
            battleId: BATTLE_ID,
            conditionId: VictoryConditionId.make("condition-missing"),
            state: "scoped",
          },
          readModel: makeReadModel({ battles: [makeBattle()] }),
        }),
      );
      expect(result._tag).toBe("Failure");
    }),
  );

  it.effect("refuses to declare fighting until the battle lines are drawn", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        decideOrchestrationCommand({
          command: {
            type: "battle.declare-fighting",
            commandId: CommandId.make("cmd-fight-early"),
            battleId: BATTLE_ID,
          },
          readModel: makeReadModel({
            battles: [
              makeBattle({
                victoryConditions: [
                  makeCondition({ id: "condition-1", state: "scoped" }),
                  makeCondition({ id: "condition-2", state: "scoping" }),
                ],
              }),
            ],
          }),
        }),
      );
      expect(result._tag).toBe("Failure");
    }),
  );

  it.effect("refuses to declare fighting when every condition was struck", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        decideOrchestrationCommand({
          command: {
            type: "battle.declare-fighting",
            commandId: CommandId.make("cmd-fight-all-struck"),
            battleId: BATTLE_ID,
          },
          readModel: makeReadModel({
            battles: [
              makeBattle({
                victoryConditions: [makeCondition({ id: "condition-1", state: "descoped" })],
              }),
            ],
          }),
        }),
      );
      expect(result._tag).toBe("Failure");
    }),
  );

  it.effect("declares fighting once every condition is resolved and one survives", () =>
    Effect.gen(function* () {
      const decided = yield* decideOrchestrationCommand({
        command: {
          type: "battle.declare-fighting",
          commandId: CommandId.make("cmd-fight"),
          battleId: BATTLE_ID,
        },
        readModel: makeReadModel({
          battles: [
            makeBattle({
              victoryConditions: [
                makeCondition({ id: "condition-1", state: "scoped" }),
                makeCondition({ id: "condition-2", state: "descoped" }),
              ],
            }),
          ],
        }),
      });
      const event = Array.isArray(decided) ? decided[0] : decided;
      expect(event?.type).toBe("battle.phase-changed");
      if (event?.type === "battle.phase-changed") {
        expect(event.payload.phase).toBe("fighting");
        expect(event.payload.defeatedAt).toBeNull();
        expect(event.payload.retireWorktrees).toBeNull();
      }
    }),
  );

  it.effect("declares defeat carrying the user's retirement choice", () =>
    Effect.gen(function* () {
      const decided = yield* decideOrchestrationCommand({
        command: {
          type: "battle.declare-defeat",
          commandId: CommandId.make("cmd-defeat"),
          battleId: BATTLE_ID,
          retireWorktrees: true,
        },
        readModel: makeReadModel({ battles: [makeBattle({ phase: "fighting" })] }),
      });
      const event = Array.isArray(decided) ? decided[0] : decided;
      expect(event?.type).toBe("battle.phase-changed");
      if (event?.type === "battle.phase-changed") {
        expect(event.payload.phase).toBe("defeated");
        expect(event.payload.retireWorktrees).toBe(true);
        expect(event.payload.defeatedAt).toBe(event.payload.updatedAt);
      }
    }),
  );

  it.effect("reopening a defeated battle clears its defeat stamp", () =>
    Effect.gen(function* () {
      const decided = yield* decideOrchestrationCommand({
        command: {
          type: "battle.reopen",
          commandId: CommandId.make("cmd-reopen"),
          battleId: BATTLE_ID,
        },
        readModel: makeReadModel({
          battles: [makeBattle({ phase: "defeated", defeatedAt: NOW })],
        }),
      });
      const event = Array.isArray(decided) ? decided[0] : decided;
      expect(event?.type).toBe("battle.phase-changed");
      if (event?.type === "battle.phase-changed") {
        expect(event.payload.phase).toBe("fighting");
        expect(event.payload.defeatedAt).toBeNull();
        expect(event.payload.retireWorktrees).toBeNull();
      }
    }),
  );

  it.effect("rejects reopening a battle that is still being fought", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        decideOrchestrationCommand({
          command: {
            type: "battle.reopen",
            commandId: CommandId.make("cmd-reopen-fighting"),
            battleId: BATTLE_ID,
          },
          readModel: makeReadModel({ battles: [makeBattle({ phase: "fighting" })] }),
        }),
      );
      expect(result._tag).toBe("Failure");
    }),
  );

  it.effect("deletes a battle that has no member threads", () =>
    Effect.gen(function* () {
      const decided = yield* decideOrchestrationCommand({
        command: {
          type: "battle.delete",
          commandId: CommandId.make("cmd-delete"),
          battleId: BATTLE_ID,
        },
        readModel: makeReadModel({ battles: [makeBattle()], threadBattleId: null }),
      });
      const event = Array.isArray(decided) ? decided[0] : decided;
      expect(event?.type).toBe("battle.deleted");
    }),
  );

  it.effect("refuses to delete a battle that still has member threads", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        decideOrchestrationCommand({
          command: {
            type: "battle.delete",
            commandId: CommandId.make("cmd-delete-with-members"),
            battleId: BATTLE_ID,
          },
          readModel: makeReadModel({ battles: [makeBattle()], threadBattleId: BATTLE_ID }),
        }),
      );
      expect(result._tag).toBe("Failure");
    }),
  );

  it.effect("stamps battleId onto a thread created inside a battle", () =>
    Effect.gen(function* () {
      const decided = yield* decideOrchestrationCommand({
        command: {
          type: "thread.create",
          commandId: CommandId.make("cmd-thread-create"),
          threadId: ThreadId.make("thread-new"),
          projectId: PROJECT_ID,
          battleId: BATTLE_ID,
          title: "Thread",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: NOW,
        },
        readModel: makeReadModel({ battles: [makeBattle()] }),
      });
      const event = Array.isArray(decided) ? decided[0] : decided;
      expect(event?.type).toBe("thread.created");
      if (event?.type === "thread.created") {
        expect(event.payload.battleId).toBe(BATTLE_ID);
      }
    }),
  );

  it.effect("refuses to enlist a new thread in a defeated battle", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        decideOrchestrationCommand({
          command: {
            type: "thread.create",
            commandId: CommandId.make("cmd-thread-create-defeated"),
            threadId: ThreadId.make("thread-new"),
            projectId: PROJECT_ID,
            battleId: BATTLE_ID,
            title: "Thread",
            modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdAt: NOW,
          },
          readModel: makeReadModel({
            battles: [makeBattle({ phase: "defeated", defeatedAt: NOW })],
          }),
        }),
      );
      expect(result._tag).toBe("Failure");
    }),
  );

  it.effect("binds a battle to its orchestrator thread", () =>
    Effect.gen(function* () {
      const decided = yield* decideOrchestrationCommand({
        command: {
          type: "battle.orchestrator.set",
          commandId: CommandId.make("cmd-orchestrator-set"),
          battleId: BATTLE_ID,
          threadId: ThreadId.make("thread-1"),
        },
        readModel: makeReadModel({ battles: [makeBattle()], threadBattleId: BATTLE_ID }),
      });
      const event = Array.isArray(decided) ? decided[0] : decided;
      expect(event?.type).toBe("battle.orchestrator-set");
      if (event?.type === "battle.orchestrator-set") {
        expect(event.aggregateKind).toBe("battle");
        expect(event.payload.orchestratorThreadId).toBe(ThreadId.make("thread-1"));
      }
    }),
  );

  it.effect("refuses a second orchestrator on one battle", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        decideOrchestrationCommand({
          command: {
            type: "battle.orchestrator.set",
            commandId: CommandId.make("cmd-orchestrator-set-second"),
            battleId: BATTLE_ID,
            threadId: ThreadId.make("thread-1"),
          },
          readModel: makeReadModel({
            battles: [makeBattle({ orchestratorThreadId: ThreadId.make("thread-existing") })],
            threadBattleId: BATTLE_ID,
          }),
        }),
      );
      expect(result._tag).toBe("Failure");
    }),
  );

  it.effect("refuses an orchestrator thread that is not a member of the battle", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        decideOrchestrationCommand({
          command: {
            type: "battle.orchestrator.set",
            commandId: CommandId.make("cmd-orchestrator-set-outsider"),
            battleId: BATTLE_ID,
            threadId: ThreadId.make("thread-1"),
          },
          readModel: makeReadModel({ battles: [makeBattle()], threadBattleId: null }),
        }),
      );
      expect(result._tag).toBe("Failure");
    }),
  );

  it.effect("records a queued turn on its thread", () =>
    Effect.gen(function* () {
      const decided = yield* decideOrchestrationCommand({
        command: {
          type: "thread.turn-queue.update",
          commandId: CommandId.make("cmd-turn-queue"),
          threadId: ThreadId.make("thread-1"),
          turnQueued: true,
          createdAt: NOW,
        },
        readModel: makeReadModel({ threadBattleId: BATTLE_ID }),
      });
      const event = Array.isArray(decided) ? decided[0] : decided;
      expect(event?.type).toBe("thread.turn-queue-updated");
      if (event?.type === "thread.turn-queue-updated") {
        expect(event.aggregateKind).toBe("thread");
        expect(event.payload.turnQueued).toBe(true);
      }
    }),
  );
});
