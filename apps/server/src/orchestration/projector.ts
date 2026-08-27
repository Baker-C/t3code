import type {
  BattleId,
  BattleQueueEntry,
  OrchestrationBattle,
  OrchestrationEvent,
  OrchestrationReadModel,
  QueueAction,
  QueueActionId,
  ThreadId,
} from "@t3tools/contracts";
import {
  DEFAULT_QUEUE_PRIORITY,
  resolveQueueEntries,
  OrchestrationCheckpointSummary,
  OrchestrationMessage,
  OrchestrationSession,
  OrchestrationThread,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { toProjectorDecodeError, type OrchestrationProjectorDecodeError } from "./Errors.ts";
import {
  BattleConditionAddedPayload,
  BattlePrioritySetPayload,
  BattleThreadGroupsSetPayload,
  BattleConditionStruckPayload,
  BattleConditionUpdatedPayload,
  BattleCreatedPayload,
  BattleDeletedPayload,
  BattleMetaUpdatedPayload,
  BattleOrchestratorSetPayload,
  BattlePhaseChangedPayload,
  MessageSentPayloadSchema,
  ProjectCreatedPayload,
  ProjectDeletedPayload,
  ProjectMetaUpdatedPayload,
  ProjectPrioritySetPayload,
  QueueActionClearedPayload,
  QueueActionSettledPayload,
  QueueActionStartedPayload,
  QueueActionWakeRuleSetPayload,
  QueueEntryAddedPayload,
  QueueEntryRemovedPayload,
  QueueEntrySkippedPayload,
  QueueLapResetPayload,
  ThreadActivityAppendedPayload,
  ThreadArchivedPayload,
  ThreadCreatedPayload,
  ThreadDeletedPayload,
  ThreadInteractionModeSetPayload,
  ThreadMetaUpdatedPayload,
  ThreadProposedPlanUpsertedPayload,
  ThreadRuntimeModeSetPayload,
  ThreadSettledPayload,
  ThreadPinnedPayload,
  ThreadPinReorderedPayload,
  ThreadSnoozedPayload,
  ThreadUnpinnedPayload,
  ThreadUnarchivedPayload,
  ThreadUnsettledPayload,
  ThreadUnsnoozedPayload,
  ThreadRevertedPayload,
  ThreadSessionSetPayload,
  ThreadTurnDiffCompletedPayload,
  ThreadTurnQueueUpdatedPayload,
} from "./Schemas.ts";

// battleId is stamped at creation and never patched: enlistment is immutable.
type ThreadPatch = Partial<Omit<OrchestrationThread, "id" | "projectId" | "battleId">>;
type BattlePatch = Partial<Omit<OrchestrationBattle, "id" | "projectId">>;
const MAX_THREAD_MESSAGES = 2_000;
const MAX_THREAD_CHECKPOINTS = 500;

function checkpointStatusToLatestTurnState(status: "ready" | "missing" | "error") {
  if (status === "error") return "error" as const;
  if (status === "missing") return "interrupted" as const;
  return "completed" as const;
}

/**
 * Turn state to settle a still-running latest turn with when its session
 * leaves the "running" status, or null while the session is (re)starting or
 * running and the turn must stay unsettled.
 */
function settledTurnStateForSessionStatus(
  status: OrchestrationSession["status"],
): "completed" | "interrupted" | "error" | null {
  switch (status) {
    case "idle":
    case "ready":
      return "completed";
    case "error":
      return "error";
    case "interrupted":
    case "stopped":
      return "interrupted";
    case "starting":
    case "running":
      return null;
  }
}

function updateThread(
  threads: ReadonlyArray<OrchestrationThread>,
  threadId: ThreadId,
  patch: ThreadPatch,
): OrchestrationThread[] {
  return threads.map((thread) => (thread.id === threadId ? { ...thread, ...patch } : thread));
}

function updateBattle(
  battles: ReadonlyArray<OrchestrationBattle>,
  battleId: BattleId,
  patch: BattlePatch,
): OrchestrationBattle[] {
  return battles.map((battle) => (battle.id === battleId ? { ...battle, ...patch } : battle));
}

type QueueEntryPatch = Partial<Omit<BattleQueueEntry, "battleId" | "projectId">>;

function updateQueueEntry(
  entries: ReadonlyArray<BattleQueueEntry>,
  battleId: BattleId,
  patch: QueueEntryPatch,
): BattleQueueEntry[] {
  return entries.map((entry) => (entry.battleId === battleId ? { ...entry, ...patch } : entry));
}

/** Patches one action of one entry, stamping the entry's updatedAt with it. */
function updateQueueAction(
  entries: ReadonlyArray<BattleQueueEntry>,
  battleId: BattleId,
  actionId: QueueActionId,
  patch: Partial<Omit<QueueAction, "id">>,
  updatedAt: string,
): BattleQueueEntry[] {
  return entries.map((entry) =>
    entry.battleId === battleId
      ? {
          ...entry,
          actions: entry.actions.map((action) =>
            action.id === actionId ? { ...action, ...patch } : action,
          ),
          updatedAt,
        }
      : entry,
  );
}

function updateBattleCondition(
  battles: ReadonlyArray<OrchestrationBattle>,
  battleId: BattleId,
  conditionId: string,
  patch: Partial<Omit<OrchestrationBattle["victoryConditions"][number], "id">>,
  updatedAt: string,
): OrchestrationBattle[] {
  return updateBattle(battles, battleId, {
    victoryConditions: (
      battles.find((battle) => battle.id === battleId)?.victoryConditions ?? []
    ).map((condition) =>
      condition.id === conditionId ? { ...condition, ...patch, updatedAt } : condition,
    ),
    updatedAt,
  });
}

function decodeForEvent<A>(
  schema: Schema.Decoder<A, never>,
  value: unknown,
  eventType: OrchestrationEvent["type"],
  field: string,
): Effect.Effect<A, OrchestrationProjectorDecodeError> {
  return Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.mapError(toProjectorDecodeError(`${eventType}:${field}`)),
  );
}

function retainThreadMessagesAfterRevert(
  messages: ReadonlyArray<OrchestrationMessage>,
  retainedTurnIds: ReadonlySet<string>,
  turnCount: number,
): ReadonlyArray<OrchestrationMessage> {
  const retainedMessageIds = new Set<string>();
  for (const message of messages) {
    if (message.role === "system") {
      retainedMessageIds.add(message.id);
      continue;
    }
    if (message.turnId !== null && retainedTurnIds.has(message.turnId)) {
      retainedMessageIds.add(message.id);
    }
  }

  const retainedUserCount = messages.filter(
    (message) => message.role === "user" && retainedMessageIds.has(message.id),
  ).length;
  const missingUserCount = Math.max(0, turnCount - retainedUserCount);
  if (missingUserCount > 0) {
    const fallbackUserMessages = messages
      .filter(
        (message) =>
          message.role === "user" &&
          !retainedMessageIds.has(message.id) &&
          (message.turnId === null || retainedTurnIds.has(message.turnId)),
      )
      .toSorted(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
      )
      .slice(0, missingUserCount);
    for (const message of fallbackUserMessages) {
      retainedMessageIds.add(message.id);
    }
  }

  const retainedAssistantCount = messages.filter(
    (message) => message.role === "assistant" && retainedMessageIds.has(message.id),
  ).length;
  const missingAssistantCount = Math.max(0, turnCount - retainedAssistantCount);
  if (missingAssistantCount > 0) {
    const fallbackAssistantMessages = messages
      .filter(
        (message) =>
          message.role === "assistant" &&
          !retainedMessageIds.has(message.id) &&
          (message.turnId === null || retainedTurnIds.has(message.turnId)),
      )
      .toSorted(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
      )
      .slice(0, missingAssistantCount);
    for (const message of fallbackAssistantMessages) {
      retainedMessageIds.add(message.id);
    }
  }

  return messages.filter((message) => retainedMessageIds.has(message.id));
}

function retainThreadActivitiesAfterRevert(
  activities: ReadonlyArray<OrchestrationThread["activities"][number]>,
  retainedTurnIds: ReadonlySet<string>,
): ReadonlyArray<OrchestrationThread["activities"][number]> {
  return activities.filter(
    (activity) => activity.turnId === null || retainedTurnIds.has(activity.turnId),
  );
}

function retainThreadProposedPlansAfterRevert(
  proposedPlans: ReadonlyArray<OrchestrationThread["proposedPlans"][number]>,
  retainedTurnIds: ReadonlySet<string>,
): ReadonlyArray<OrchestrationThread["proposedPlans"][number]> {
  return proposedPlans.filter(
    (proposedPlan) => proposedPlan.turnId === null || retainedTurnIds.has(proposedPlan.turnId),
  );
}

function compareThreadActivities(
  left: OrchestrationThread["activities"][number],
  right: OrchestrationThread["activities"][number],
): number {
  if (left.sequence !== undefined && right.sequence !== undefined) {
    if (left.sequence !== right.sequence) {
      return left.sequence - right.sequence;
    }
  } else if (left.sequence !== undefined) {
    return 1;
  } else if (right.sequence !== undefined) {
    return -1;
  }

  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

export function createEmptyReadModel(nowIso: string): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [],
    threads: [],
    battles: [],
    queueEntries: [],
    updatedAt: nowIso,
  };
}

export function projectEvent(
  model: OrchestrationReadModel,
  event: OrchestrationEvent,
): Effect.Effect<OrchestrationReadModel, OrchestrationProjectorDecodeError> {
  const nextBase: OrchestrationReadModel = {
    ...model,
    snapshotSequence: event.sequence,
    updatedAt: event.occurredAt,
  };

  switch (event.type) {
    case "project.created":
      return decodeForEvent(ProjectCreatedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => {
          const existing = nextBase.projects.find((entry) => entry.id === payload.projectId);
          const nextProject = {
            id: payload.projectId,
            title: payload.title,
            workspaceRoot: payload.workspaceRoot,
            defaultModelSelection: payload.defaultModelSelection,
            defaultThreadEnvMode: null,
            faviconPath: payload.faviconPath ?? null,
            scripts: payload.scripts,
            priority: DEFAULT_QUEUE_PRIORITY,
            createdAt: payload.createdAt,
            updatedAt: payload.updatedAt,
            deletedAt: null,
          };

          return {
            ...nextBase,
            projects: existing
              ? nextBase.projects.map((entry) =>
                  entry.id === payload.projectId ? nextProject : entry,
                )
              : [...nextBase.projects, nextProject],
          };
        }),
      );

    case "project.meta-updated":
      return decodeForEvent(ProjectMetaUpdatedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          projects: nextBase.projects.map((project) =>
            project.id === payload.projectId
              ? {
                  ...project,
                  ...(payload.title !== undefined ? { title: payload.title } : {}),
                  ...(payload.workspaceRoot !== undefined
                    ? { workspaceRoot: payload.workspaceRoot }
                    : {}),
                  ...(payload.defaultModelSelection !== undefined
                    ? { defaultModelSelection: payload.defaultModelSelection }
                    : {}),
                  ...(payload.defaultThreadEnvMode !== undefined
                    ? { defaultThreadEnvMode: payload.defaultThreadEnvMode }
                    : {}),
                  ...(payload.faviconPath !== undefined
                    ? { faviconPath: payload.faviconPath }
                    : {}),
                  ...(payload.scripts !== undefined ? { scripts: payload.scripts } : {}),
                  updatedAt: payload.updatedAt,
                }
              : project,
          ),
        })),
      );

    case "project.deleted":
      return decodeForEvent(ProjectDeletedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          projects: nextBase.projects.map((project) =>
            project.id === payload.projectId
              ? {
                  ...project,
                  deletedAt: payload.deletedAt,
                  updatedAt: payload.deletedAt,
                }
              : project,
          ),
        })),
      );

    case "battle.created":
      return decodeForEvent(BattleCreatedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => {
          const nextBattle: OrchestrationBattle = {
            id: payload.battleId,
            projectId: payload.projectId,
            title: payload.title,
            goal: payload.goal,
            slug: payload.slug,
            phase: "scoping",
            victoryConditions: [],
            orchestratorThreadId: null,
            priority: DEFAULT_QUEUE_PRIORITY,
            threadGroups: [],
            defeatedAt: null,
            createdAt: payload.createdAt,
            updatedAt: payload.updatedAt,
            deletedAt: null,
          };
          const existing = nextBase.battles.find((entry) => entry.id === payload.battleId);
          return {
            ...nextBase,
            battles: existing
              ? nextBase.battles.map((entry) =>
                  entry.id === payload.battleId ? nextBattle : entry,
                )
              : [...nextBase.battles, nextBattle],
          };
        }),
      );

    case "battle.meta-updated":
      return decodeForEvent(BattleMetaUpdatedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          battles: updateBattle(nextBase.battles, payload.battleId, {
            ...(payload.title !== undefined ? { title: payload.title } : {}),
            ...(payload.goal !== undefined ? { goal: payload.goal } : {}),
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "battle.condition-added":
      return decodeForEvent(BattleConditionAddedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => {
          const battle = nextBase.battles.find((entry) => entry.id === payload.battleId);
          if (!battle) {
            return nextBase;
          }
          return {
            ...nextBase,
            battles: updateBattle(nextBase.battles, payload.battleId, {
              victoryConditions: [
                ...battle.victoryConditions.filter((entry) => entry.id !== payload.condition.id),
                payload.condition,
              ],
              updatedAt: payload.updatedAt,
            }),
          };
        }),
      );

    case "battle.condition-updated":
      return decodeForEvent(
        BattleConditionUpdatedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => ({
          ...nextBase,
          battles: updateBattleCondition(
            nextBase.battles,
            payload.battleId,
            payload.conditionId,
            {
              ...(payload.title !== undefined ? { title: payload.title } : {}),
              ...(payload.state !== undefined ? { state: payload.state } : {}),
              ...(payload.sizeScore !== undefined ? { sizeScore: payload.sizeScore } : {}),
              ...(payload.sizeProvisional !== undefined
                ? { sizeProvisional: payload.sizeProvisional }
                : {}),
              ...(payload.ownerThreadId !== undefined
                ? { ownerThreadId: payload.ownerThreadId }
                : {}),
              updatedByThreadId: payload.updatedByThreadId,
            },
            payload.updatedAt,
          ),
        })),
      );

    case "battle.condition-struck":
      return decodeForEvent(
        BattleConditionStruckPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => ({
          ...nextBase,
          battles: updateBattleCondition(
            nextBase.battles,
            payload.battleId,
            payload.conditionId,
            {
              state: "descoped",
              strikeReason: payload.strikeReason,
              updatedByThreadId: payload.updatedByThreadId,
            },
            payload.updatedAt,
          ),
        })),
      );

    case "battle.phase-changed":
      return decodeForEvent(BattlePhaseChangedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          battles: updateBattle(nextBase.battles, payload.battleId, {
            phase: payload.phase,
            defeatedAt: payload.defeatedAt,
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "battle.orchestrator-set":
      return decodeForEvent(
        BattleOrchestratorSetPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => ({
          ...nextBase,
          battles: updateBattle(nextBase.battles, payload.battleId, {
            orchestratorThreadId: payload.orchestratorThreadId,
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "project.priority-set":
      return decodeForEvent(ProjectPrioritySetPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          projects: nextBase.projects.map((project) =>
            project.id === payload.projectId
              ? { ...project, priority: payload.priority, updatedAt: payload.updatedAt }
              : project,
          ),
        })),
      );

    case "battle.priority-set":
      return decodeForEvent(BattlePrioritySetPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          battles: updateBattle(nextBase.battles, payload.battleId, {
            priority: payload.priority,
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "battle.thread-groups-set":
      return decodeForEvent(
        BattleThreadGroupsSetPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => ({
          ...nextBase,
          battles: updateBattle(nextBase.battles, payload.battleId, {
            threadGroups: payload.groups,
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "queue.entry-added":
      return decodeForEvent(QueueEntryAddedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => {
          const entry: BattleQueueEntry = {
            battleId: payload.battleId,
            projectId: payload.projectId,
            orderKey: payload.orderKey,
            // A fresh row is fair game this lap: you have not passed it over.
            skippedInLap: false,
            // Dormant: present and prioritised, with no action yet.
            actions: [],
            addedAt: payload.addedAt,
            updatedAt: payload.addedAt,
          };
          const existing = resolveQueueEntries(nextBase.queueEntries).some(
            (candidate) => candidate.battleId === payload.battleId,
          );
          return {
            ...nextBase,
            queueEntries: existing
              ? resolveQueueEntries(nextBase.queueEntries).map((candidate) =>
                  candidate.battleId === payload.battleId ? entry : candidate,
                )
              : [...resolveQueueEntries(nextBase.queueEntries), entry],
          };
        }),
      );

    case "queue.entry-removed":
      return decodeForEvent(QueueEntryRemovedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          // Removed outright rather than tombstoned. The queue is deliberately
          // disposable; the battles themselves are the durable record.
          queueEntries: resolveQueueEntries(nextBase.queueEntries).filter(
            (entry) => entry.battleId !== payload.battleId,
          ),
        })),
      );

    case "queue.entry-skipped":
      return decodeForEvent(QueueEntrySkippedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          queueEntries: updateQueueEntry(
            resolveQueueEntries(nextBase.queueEntries),
            payload.battleId,
            {
              skippedInLap: true,
              updatedAt: payload.skippedAt,
            },
          ),
        })),
      );

    case "queue.lap-reset":
      return decodeForEvent(QueueLapResetPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          queueEntries: resolveQueueEntries(nextBase.queueEntries).map((entry) =>
            entry.skippedInLap
              ? { ...entry, skippedInLap: false, updatedAt: payload.resetAt }
              : entry,
          ),
        })),
      );

    case "queue.action-started":
      return decodeForEvent(QueueActionStartedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => {
          const entry = resolveQueueEntries(nextBase.queueEntries).find(
            (candidate) => candidate.battleId === payload.battleId,
          );
          if (!entry) return nextBase;
          const existing = entry.actions.find((action) => action.id === payload.actionId);
          // Re-starting an open action widens it: a second thread joining the
          // same kick-off belongs to the action already covering its group,
          // not to a new one that would double the battle's ready count.
          const nextAction: QueueAction = existing
            ? {
                ...existing,
                threadIds: [
                  ...existing.threadIds,
                  ...payload.threadIds.filter((threadId) => !existing.threadIds.includes(threadId)),
                ],
              }
            : {
                id: payload.actionId,
                threadIds: payload.threadIds,
                wakeRule: payload.wakeRule,
                outcome: null,
                startedAt: payload.startedAt,
                readyAt: null,
              };
          return {
            ...nextBase,
            queueEntries: updateQueueEntry(
              resolveQueueEntries(nextBase.queueEntries),
              payload.battleId,
              {
                actions: existing
                  ? entry.actions.map((action) =>
                      action.id === payload.actionId ? nextAction : action,
                    )
                  : [...entry.actions, nextAction],
                updatedAt: payload.startedAt,
              },
            ),
          };
        }),
      );

    case "queue.action-wake-rule-set":
      return decodeForEvent(
        QueueActionWakeRuleSetPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => ({
          ...nextBase,
          queueEntries: updateQueueAction(
            resolveQueueEntries(nextBase.queueEntries),
            payload.battleId,
            payload.actionId,
            { wakeRule: payload.wakeRule },
            payload.updatedAt,
          ),
        })),
      );

    case "queue.action-settled":
      return decodeForEvent(QueueActionSettledPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => {
          const withOutcome = updateQueueAction(
            resolveQueueEntries(nextBase.queueEntries),
            payload.battleId,
            payload.actionId,
            { outcome: payload.outcome, readyAt: payload.readyAt },
            payload.readyAt,
          );
          return {
            ...nextBase,
            // Skip invalidation: new work is new information, so a battle you
            // passed over earns its place back in the lap the moment something
            // in it wants you again.
            queueEntries: updateQueueEntry(withOutcome, payload.battleId, {
              skippedInLap: false,
            }),
          };
        }),
      );

    case "queue.action-cleared":
      return decodeForEvent(QueueActionClearedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => {
          const entry = resolveQueueEntries(nextBase.queueEntries).find(
            (candidate) => candidate.battleId === payload.battleId,
          );
          if (!entry) return nextBase;
          return {
            ...nextBase,
            queueEntries: updateQueueEntry(
              resolveQueueEntries(nextBase.queueEntries),
              payload.battleId,
              {
                actions: entry.actions.filter((action) => action.id !== payload.actionId),
                updatedAt: payload.clearedAt,
              },
            ),
          };
        }),
      );

    case "battle.deleted":
      return decodeForEvent(BattleDeletedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          battles: updateBattle(nextBase.battles, payload.battleId, {
            deletedAt: payload.deletedAt,
            updatedAt: payload.deletedAt,
          }),
        })),
      );

    case "thread.created":
      return Effect.gen(function* () {
        const payload = yield* decodeForEvent(
          ThreadCreatedPayload,
          event.payload,
          event.type,
          "payload",
        );
        const thread: OrchestrationThread = yield* decodeForEvent(
          OrchestrationThread,
          {
            id: payload.threadId,
            projectId: payload.projectId,
            battleId: payload.battleId ?? null,
            isOrchestrator: payload.isOrchestrator ?? false,
            title: payload.title,
            modelSelection: payload.modelSelection,
            runtimeMode: payload.runtimeMode,
            interactionMode: payload.interactionMode,
            branch: payload.branch,
            worktreePath: payload.worktreePath,
            latestTurn: null,
            createdAt: payload.createdAt,
            updatedAt: payload.updatedAt,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            snoozedUntil: null,
            snoozedAt: null,
            deletedAt: null,
            messages: [],
            activities: [],
            checkpoints: [],
            session: null,
          },
          event.type,
          "thread",
        );
        const existing = nextBase.threads.find((entry) => entry.id === thread.id);
        return {
          ...nextBase,
          threads: existing
            ? nextBase.threads.map((entry) => (entry.id === thread.id ? thread : entry))
            : [...nextBase.threads, thread],
        };
      });

    case "thread.turn-queue-updated":
      return decodeForEvent(
        ThreadTurnQueueUpdatedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            turnQueued: payload.turnQueued,
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "thread.deleted":
      return decodeForEvent(ThreadDeletedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            deletedAt: payload.deletedAt,
            updatedAt: payload.deletedAt,
          }),
        })),
      );

    case "thread.archived":
      return decodeForEvent(ThreadArchivedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            archivedAt: payload.archivedAt,
            titleRegeneration: null,
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "thread.unarchived":
      return decodeForEvent(ThreadUnarchivedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            archivedAt: null,
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "thread.settled":
      return decodeForEvent(ThreadSettledPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            settledOverride: "settled",
            settledAt: payload.settledAt,
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "thread.unsettled":
      return decodeForEvent(ThreadUnsettledPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            settledOverride: payload.reason === "user" ? "active" : null,
            settledAt: null,
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "thread.snoozed":
      return decodeForEvent(ThreadSnoozedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            snoozedUntil: payload.snoozedUntil,
            snoozedAt: payload.snoozedAt,
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "thread.unsnoozed":
      return decodeForEvent(ThreadUnsnoozedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            snoozedUntil: null,
            snoozedAt: null,
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "thread.pinned":
      return decodeForEvent(ThreadPinnedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            pinnedAt: payload.pinnedAt,
            ...(payload.pinOrderKey !== undefined ? { pinOrderKey: payload.pinOrderKey } : {}),
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "thread.unpinned":
      return decodeForEvent(ThreadUnpinnedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            pinnedAt: null,
            // Unpin clears the slot: re-pinning is "pin again", not "restore
            // an ancient position".
            pinOrderKey: null,
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "thread.pin-reordered":
      return decodeForEvent(ThreadPinReorderedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            pinOrderKey: payload.orderKey,
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "thread.meta-updated":
      return decodeForEvent(ThreadMetaUpdatedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            ...(payload.title !== undefined ? { title: payload.title } : {}),
            ...(payload.titleRegeneration !== undefined
              ? { titleRegeneration: payload.titleRegeneration }
              : {}),
            ...(payload.modelSelection !== undefined
              ? { modelSelection: payload.modelSelection }
              : {}),
            ...(payload.branch !== undefined ? { branch: payload.branch } : {}),
            ...(payload.worktreePath !== undefined ? { worktreePath: payload.worktreePath } : {}),
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "thread.runtime-mode-set":
      return decodeForEvent(ThreadRuntimeModeSetPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            runtimeMode: payload.runtimeMode,
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "thread.interaction-mode-set":
      return decodeForEvent(
        ThreadInteractionModeSetPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            interactionMode: payload.interactionMode,
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "thread.message-sent":
      return Effect.gen(function* () {
        const payload = yield* decodeForEvent(
          MessageSentPayloadSchema,
          event.payload,
          event.type,
          "payload",
        );
        const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
        if (!thread) {
          return nextBase;
        }

        const message: OrchestrationMessage = yield* decodeForEvent(
          OrchestrationMessage,
          {
            id: payload.messageId,
            role: payload.role,
            text: payload.text,
            ...(payload.attachments !== undefined ? { attachments: payload.attachments } : {}),
            turnId: payload.turnId,
            streaming: payload.streaming,
            createdAt: payload.createdAt,
            updatedAt: payload.updatedAt,
          },
          event.type,
          "message",
        );

        const existingMessage = thread.messages.find((entry) => entry.id === message.id);
        const messages = existingMessage
          ? thread.messages.map((entry) =>
              entry.id === message.id
                ? {
                    ...entry,
                    text: message.streaming
                      ? `${entry.text}${message.text}`
                      : message.text.length > 0
                        ? message.text
                        : entry.text,
                    streaming: message.streaming,
                    updatedAt: message.updatedAt,
                    turnId: message.turnId,
                    ...(message.attachments !== undefined
                      ? { attachments: message.attachments }
                      : {}),
                  }
                : entry,
            )
          : [...thread.messages, message];
        const cappedMessages = messages.slice(-MAX_THREAD_MESSAGES);

        return {
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            messages: cappedMessages,
            updatedAt: event.occurredAt,
          }),
        };
      });

    case "thread.session-set":
      return Effect.gen(function* () {
        const payload = yield* decodeForEvent(
          ThreadSessionSetPayload,
          event.payload,
          event.type,
          "payload",
        );
        const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
        if (!thread) {
          return nextBase;
        }

        const session: OrchestrationSession = yield* decodeForEvent(
          OrchestrationSession,
          payload.session,
          event.type,
          "session",
        );

        // Leaving the "running" session status is the turn-end signal: settle
        // a still-running latest turn so its duration reflects the whole turn.
        const settledTurnState = settledTurnStateForSessionStatus(session.status);
        return {
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            session,
            latestTurn:
              session.status === "running" && session.activeTurnId !== null
                ? {
                    turnId: session.activeTurnId,
                    state: "running",
                    requestedAt:
                      thread.latestTurn?.turnId === session.activeTurnId
                        ? thread.latestTurn.requestedAt
                        : session.updatedAt,
                    startedAt:
                      thread.latestTurn?.turnId === session.activeTurnId
                        ? (thread.latestTurn.startedAt ?? session.updatedAt)
                        : session.updatedAt,
                    completedAt: null,
                    assistantMessageId:
                      thread.latestTurn?.turnId === session.activeTurnId
                        ? thread.latestTurn.assistantMessageId
                        : null,
                  }
                : thread.latestTurn !== null &&
                    thread.latestTurn.state === "running" &&
                    settledTurnState !== null
                  ? {
                      ...thread.latestTurn,
                      state: settledTurnState,
                      // A running turn's completedAt can only hold a mid-turn
                      // placeholder checkpoint timestamp — the session leaving
                      // "running" is the authoritative turn end.
                      completedAt: session.updatedAt,
                    }
                  : thread.latestTurn,
            updatedAt: event.occurredAt,
          }),
        };
      });

    case "thread.proposed-plan-upserted":
      return Effect.gen(function* () {
        const payload = yield* decodeForEvent(
          ThreadProposedPlanUpsertedPayload,
          event.payload,
          event.type,
          "payload",
        );
        const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
        if (!thread) {
          return nextBase;
        }

        const proposedPlans = [
          ...thread.proposedPlans.filter((entry) => entry.id !== payload.proposedPlan.id),
          payload.proposedPlan,
        ]
          .toSorted(
            (left, right) =>
              left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
          )
          .slice(-200);

        return {
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            proposedPlans,
            updatedAt: event.occurredAt,
          }),
        };
      });

    case "thread.turn-diff-completed":
      return Effect.gen(function* () {
        const payload = yield* decodeForEvent(
          ThreadTurnDiffCompletedPayload,
          event.payload,
          event.type,
          "payload",
        );
        const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
        if (!thread) {
          return nextBase;
        }

        const checkpoint = yield* decodeForEvent(
          OrchestrationCheckpointSummary,
          {
            turnId: payload.turnId,
            checkpointTurnCount: payload.checkpointTurnCount,
            checkpointRef: payload.checkpointRef,
            status: payload.status,
            files: payload.files,
            assistantMessageId: payload.assistantMessageId,
            completedAt: payload.completedAt,
          },
          event.type,
          "checkpoint",
        );

        // Do not let a placeholder (status "missing") overwrite a checkpoint
        // that has already been captured with a real git ref (status "ready").
        // ProviderRuntimeIngestion may fire multiple turn.diff.updated events
        // per turn; without this guard later placeholders would clobber the
        // real capture dispatched by CheckpointReactor.
        const existing = thread.checkpoints.find((entry) => entry.turnId === checkpoint.turnId);
        if (existing && existing.status !== "missing" && checkpoint.status === "missing") {
          return nextBase;
        }

        const checkpoints = [
          ...thread.checkpoints.filter((entry) => entry.turnId !== checkpoint.turnId),
          checkpoint,
        ]
          .toSorted((left, right) => left.checkpointTurnCount - right.checkpointTurnCount)
          .slice(-MAX_THREAD_CHECKPOINTS);

        // Mid-turn diff updates produce placeholder checkpoints; record the
        // checkpoint, but don't settle a turn its session is still running.
        const turnStillRunning =
          thread.session?.status === "running" && thread.session.activeTurnId === payload.turnId;

        return {
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            checkpoints,
            latestTurn: turnStillRunning
              ? thread.latestTurn
              : {
                  turnId: payload.turnId,
                  state: checkpointStatusToLatestTurnState(payload.status),
                  requestedAt:
                    thread.latestTurn?.turnId === payload.turnId
                      ? thread.latestTurn.requestedAt
                      : payload.completedAt,
                  startedAt:
                    thread.latestTurn?.turnId === payload.turnId
                      ? (thread.latestTurn.startedAt ?? payload.completedAt)
                      : payload.completedAt,
                  completedAt: payload.completedAt,
                  assistantMessageId: payload.assistantMessageId,
                },
            updatedAt: event.occurredAt,
          }),
        };
      });

    case "thread.reverted":
      return decodeForEvent(ThreadRevertedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => {
          const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
          if (!thread) {
            return nextBase;
          }

          const checkpoints = thread.checkpoints
            .filter((entry) => entry.checkpointTurnCount <= payload.turnCount)
            .toSorted((left, right) => left.checkpointTurnCount - right.checkpointTurnCount)
            .slice(-MAX_THREAD_CHECKPOINTS);
          const retainedTurnIds = new Set(checkpoints.map((checkpoint) => checkpoint.turnId));
          const messages = retainThreadMessagesAfterRevert(
            thread.messages,
            retainedTurnIds,
            payload.turnCount,
          ).slice(-MAX_THREAD_MESSAGES);
          const proposedPlans = retainThreadProposedPlansAfterRevert(
            thread.proposedPlans,
            retainedTurnIds,
          ).slice(-200);
          const activities = retainThreadActivitiesAfterRevert(thread.activities, retainedTurnIds);

          const latestCheckpoint = checkpoints.at(-1) ?? null;
          const latestTurn =
            latestCheckpoint === null
              ? null
              : {
                  turnId: latestCheckpoint.turnId,
                  state: checkpointStatusToLatestTurnState(latestCheckpoint.status),
                  requestedAt: latestCheckpoint.completedAt,
                  startedAt: latestCheckpoint.completedAt,
                  completedAt: latestCheckpoint.completedAt,
                  assistantMessageId: latestCheckpoint.assistantMessageId,
                };

          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              checkpoints,
              messages,
              proposedPlans,
              activities,
              latestTurn,
              updatedAt: event.occurredAt,
            }),
          };
        }),
      );

    case "thread.activity-appended":
      return decodeForEvent(
        ThreadActivityAppendedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => {
          const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
          if (!thread) {
            return nextBase;
          }

          const activities = [
            ...thread.activities.filter((entry) => entry.id !== payload.activity.id),
            payload.activity,
          ]
            .toSorted(compareThreadActivities)
            .slice(-500);

          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              activities,
              updatedAt: event.occurredAt,
            }),
          };
        }),
      );

    default:
      return Effect.succeed(nextBase);
  }
}
