import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  MessageId,
  ThreadId,
  type BattleId,
  type OrchestrationEvent,
  type OrchestrationSessionStatus,
  type ProjectId,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import {
  ORCHESTRATOR_THREAD_TITLE,
  battleIdFromOrchestratorSendMessageId,
} from "../battleOrchestrator.ts";
import { ServerActivation, forkParked } from "../../serverActivation.ts";
import * as ServerRuntimeStartup from "../../serverRuntimeStartup.ts";
import {
  BattleOrchestratorReactor,
  type BattleOrchestratorReactorShape,
} from "../Services/BattleOrchestratorReactor.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { RuntimeReceiptBus } from "../Services/RuntimeReceiptBus.ts";

type BattleCreatedEvent = Extract<OrchestrationEvent, { type: "battle.created" }>;
type ThreadSessionSetEvent = Extract<OrchestrationEvent, { type: "thread.session-set" }>;
type BattleOrchestratorRefreshRequestedEvent = Extract<
  OrchestrationEvent,
  { type: "battle.orchestrator-refresh-requested" }
>;
type ReactorEvent =
  | BattleCreatedEvent
  | ThreadSessionSetEvent
  | BattleOrchestratorRefreshRequestedEvent;

/**
 * Both paths that can mint an orchestrator run through one worker, so a
 * `battle.created` and a startup backfill entry for the same battle can never
 * interleave. That serialization is what makes the check-then-create in
 * `createOrchestrator` atomic, and it is the only thing standing between a
 * doubly-seen battle and an orphaned thread.
 */
type ReactorInput =
  | { readonly source: "domain"; readonly event: ReactorEvent }
  | {
      readonly source: "backfill";
      readonly battleId: BattleId;
      readonly projectId: ProjectId;
    };

/** One member reply waiting to be handed to its battle's orchestrator. */
interface PendingReport {
  readonly memberThreadId: ThreadId;
  readonly memberTitle: string;
  readonly reply: string;
}

/** What a report carries when the member's turn produced no assistant text. */
const REPLYLESS_TURN_NOTE = "(This turn ended without an assistant reply.)";

/**
 * Mirrors `settledTurnStateForSessionStatus` in `ProjectionPipeline`: turn
 * settling is projection-internal and emits no event, so a session leaving
 * "starting"/"running" is the only turn-end signal on the wire.
 */
const isSettledSessionStatus = (status: OrchestrationSessionStatus): boolean =>
  status !== "starting" && status !== "running";

/** One turn's worth of member replies, in the order they were buffered. */
const formatReport = (reports: ReadonlyArray<PendingReport>): string =>
  reports
    .map(
      (report) =>
        `Reply from member thread "${report.memberTitle}" (${report.memberThreadId}):\n\n${report.reply}`,
    )
    .join("\n\n---\n\n");

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const randomUUID = crypto.randomUUIDv4;
  const serverCommandId = (tag: string) =>
    randomUUID.pipe(Effect.map((uuid) => CommandId.make(`server:${tag}:${uuid}`)));
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const receiptBus = yield* RuntimeReceiptBus;

  // Both maps are read and written only from the drainable worker's single
  // consumer fiber, so they need no locking.
  //
  // The buffer is deliberately in-memory: a report-back is a live nudge, not a
  // record. The durable marker is the member's send message id, which the
  // event log already keeps, so a restart loses at most an undelivered nudge
  // and never loses the ability to attribute a turn.
  const pendingReports = new Map<BattleId, Array<PendingReport>>();
  const lastReportedSend = new Map<ThreadId, string>();
  // Battles whose orchestrator we have handed a report turn and not yet seen
  // settle. The projected session status lags our own dispatch by however long
  // the provider takes to report "running", and guard 3 has to hold across that
  // window, so what we did ourselves is tracked here rather than asked for.
  const orchestratorTurnInFlight = new Set<BattleId>();

  const publishReportSettled = (input: {
    readonly battleId: BattleId;
    readonly memberThreadId: ThreadId | null;
    readonly outcome: "delivered" | "buffered" | "ignored";
    readonly deliveredFor: ReadonlyArray<ThreadId>;
  }) =>
    DateTime.now.pipe(
      Effect.flatMap((now) =>
        receiptBus.publish({
          type: "battle.orchestrator.report-settled",
          battleId: input.battleId,
          memberThreadId: input.memberThreadId,
          outcome: input.outcome,
          deliveredFor: input.deliveredFor,
          createdAt: DateTime.formatIso(now),
        }),
      ),
    );

  /**
   * Mints a battle's manager thread and binds it. The thread deliberately gets
   * no branch and no worktree: a worktree-less thread resolves to the project
   * root, and "manager only" is exactly that absence.
   */
  const createOrchestrator = Effect.fn("createOrchestrator")(function* (input: {
    readonly battleId: BattleId;
    readonly projectId: ProjectId;
    readonly source: "created" | "backfilled";
  }) {
    // Re-read under the worker's serialization: whichever path got here first
    // has already committed its binding, so this is what keeps the loser from
    // minting a thread the decider will then refuse to bind.
    const battle = yield* projectionSnapshotQuery.getBattleById(input.battleId);
    if (Option.isNone(battle)) {
      return;
    }
    if (battle.value.orchestratorThreadId !== null || battle.value.phase === "defeated") {
      return;
    }

    const project = yield* projectionSnapshotQuery.getProjectShellById(input.projectId);
    if (Option.isNone(project)) {
      yield* Effect.logWarning("battle orchestrator reactor found no project for a battle", {
        battleId: input.battleId,
        projectId: input.projectId,
      });
      return;
    }

    const uuid = yield* randomUUID;
    const threadId = ThreadId.make(uuid);
    const now = yield* DateTime.now;
    const createdAt = DateTime.formatIso(now);

    yield* orchestrationEngine.dispatch({
      type: "thread.create",
      commandId: yield* serverCommandId("battle-orchestrator-create"),
      threadId,
      projectId: input.projectId,
      battleId: input.battleId,
      title: ORCHESTRATOR_THREAD_TITLE,
      modelSelection:
        project.value.defaultModelSelection ??
        ServerRuntimeStartup.getAutoBootstrapDefaultModelSelection(),
      runtimeMode: DEFAULT_RUNTIME_MODE,
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      branch: null,
      worktreePath: null,
      isOrchestrator: true,
      createdAt,
    });
    // The decider refuses a second binding, so this is also what keeps a
    // retried creation from leaving a battle with two managers.
    yield* orchestrationEngine.dispatch({
      type: "battle.orchestrator.set",
      commandId: yield* serverCommandId("battle-orchestrator-set"),
      battleId: input.battleId,
      threadId,
    });
    yield* receiptBus.publish({
      type: "battle.orchestrator.ready",
      battleId: input.battleId,
      orchestratorThreadId: threadId,
      source: input.source,
      createdAt,
    });
  });

  /**
   * Retires a battle's manager and mints its replacement. The old thread is
   * archived rather than deleted: it keeps the reasoning behind decisions the
   * battle already acted on, and its `isOrchestrator` flag keeps it out of the
   * member lists it was never part of.
   */
  const refreshOrchestrator = Effect.fn("refreshOrchestrator")(function* (input: {
    readonly battleId: BattleId;
    readonly previousThreadId: ThreadId;
  }) {
    const battle = yield* projectionSnapshotQuery.getBattleById(input.battleId);
    if (Option.isNone(battle) || battle.value.phase === "defeated") {
      return;
    }
    // Re-read under the worker's serialization, so a double request retires one
    // manager rather than two.
    if (battle.value.orchestratorThreadId !== input.previousThreadId) {
      return;
    }

    const project = yield* projectionSnapshotQuery.getProjectShellById(battle.value.projectId);
    if (Option.isNone(project)) {
      yield* Effect.logWarning("battle orchestrator reactor found no project for a refresh", {
        battleId: input.battleId,
      });
      return;
    }

    const threadId = ThreadId.make(yield* randomUUID);
    const createdAt = DateTime.formatIso(yield* DateTime.now);

    yield* orchestrationEngine.dispatch({
      type: "thread.create",
      commandId: yield* serverCommandId("battle-orchestrator-refresh-create"),
      threadId,
      projectId: battle.value.projectId,
      battleId: input.battleId,
      title: ORCHESTRATOR_THREAD_TITLE,
      modelSelection:
        project.value.defaultModelSelection ??
        ServerRuntimeStartup.getAutoBootstrapDefaultModelSelection(),
      runtimeMode: DEFAULT_RUNTIME_MODE,
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      branch: null,
      worktreePath: null,
      isOrchestrator: true,
      createdAt,
    });
    // Compare-and-swap: a retry that arrives after this landed is refused, so
    // the replacement minted above is never itself retired by the same request.
    yield* orchestrationEngine.dispatch({
      type: "battle.orchestrator.replace",
      commandId: yield* serverCommandId("battle-orchestrator-replace"),
      battleId: input.battleId,
      previousThreadId: input.previousThreadId,
      threadId,
    });
    // Archived only once the swap is committed, so a failure leaves the battle
    // with a working manager rather than none.
    yield* orchestrationEngine.dispatch({
      type: "thread.archive",
      commandId: yield* serverCommandId("battle-orchestrator-archive"),
      threadId: input.previousThreadId,
    });
    // Replies buffered for the retired manager are dropped rather than
    // redirected: a fresh orchestrator has no context for an answer to a
    // question it never asked. The in-flight mark goes with them, because the
    // settle that would have cleared it belongs to a thread this battle no
    // longer consults - left set, it would read the replacement as forever
    // busy. Both are safe to clear here because the worker serializes this
    // against every flush.
    pendingReports.delete(input.battleId);
    orchestratorTurnInFlight.delete(input.battleId);
    yield* receiptBus.publish({
      type: "battle.orchestrator.ready",
      battleId: input.battleId,
      orchestratorThreadId: threadId,
      source: "refreshed",
      createdAt,
    });
  });

  const createOrchestratorSafely = (input: {
    readonly battleId: BattleId;
    readonly projectId: ProjectId;
    readonly source: "created" | "backfilled";
  }) =>
    createOrchestrator(input).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.interrupt;
        }
        return Effect.logWarning(
          "battle orchestrator reactor failed to create an orchestrator thread",
          {
            battleId: input.battleId,
            source: input.source,
            cause: Cause.pretty(cause),
          },
        );
      }),
    );

  /**
   * Hands every buffered reply for one battle to its orchestrator as a single
   * turn, or leaves the buffer alone while the orchestrator is mid-turn.
   *
   * `memberThreadId` names the settle that triggered this attempt, and is null
   * when the orchestrator's own turn ending is what triggered it.
   */
  const flushReports = Effect.fn("flushReports")(function* (input: {
    readonly battleId: BattleId;
    readonly orchestratorThreadId: ThreadId;
    readonly memberThreadId: ThreadId | null;
  }) {
    const pending = pendingReports.get(input.battleId);
    if (pending === undefined || pending.length === 0) {
      return;
    }

    const orchestrator = yield* projectionSnapshotQuery.getThreadShellById(
      input.orchestratorThreadId,
    );
    const status = Option.isSome(orchestrator)
      ? (orchestrator.value.session?.status ?? null)
      : null;
    // Guard 3: coalesce. Replies that land while the orchestrator is working
    // stay buffered and ride along with the next flush, so a five-member
    // battle can never start five orchestrator turns at once. A report turn we
    // dispatched ourselves counts as busy from the moment we dispatch it - the
    // projected status is only the *additional* condition, because it cannot
    // say "running" until the provider gets there.
    if (
      orchestratorTurnInFlight.has(input.battleId) ||
      status === "starting" ||
      status === "running"
    ) {
      yield* publishReportSettled({
        battleId: input.battleId,
        memberThreadId: input.memberThreadId,
        outcome: "buffered",
        deliveredFor: [],
      });
      return;
    }

    const uuid = yield* randomUUID;
    const now = yield* DateTime.now;
    yield* orchestrationEngine.dispatch({
      type: "thread.turn.start",
      commandId: yield* serverCommandId("battle-orchestrator-report"),
      threadId: input.orchestratorThreadId,
      message: {
        // Guard 4: a plain message id. `orchestratorSendMessageId` is the
        // marker that makes a turn reportable, so minting one here would let a
        // report report itself.
        messageId: MessageId.make(uuid),
        role: "user",
        text: formatReport(pending),
        attachments: [],
      },
      runtimeMode: DEFAULT_RUNTIME_MODE,
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      createdAt: DateTime.formatIso(now),
    });
    // Both cleared only once the turn is committed, so a failed dispatch keeps
    // the replies for the next attempt instead of dropping them, and never
    // wedges the orchestrator as permanently busy.
    pendingReports.delete(input.battleId);
    orchestratorTurnInFlight.add(input.battleId);

    yield* publishReportSettled({
      battleId: input.battleId,
      memberThreadId: input.memberThreadId,
      outcome: "delivered",
      deliveredFor: pending.map((report) => report.memberThreadId),
    });
  });

  const processSessionSettled = Effect.fn("processSessionSettled")(function* (
    event: ThreadSessionSetEvent,
  ) {
    const threadId = event.payload.threadId;
    const member = yield* projectionSnapshotQuery.getThreadShellById(threadId);
    if (Option.isNone(member)) {
      return;
    }
    const battleId = member.value.battleId ?? null;
    if (battleId === null) {
      return;
    }
    const battle = yield* projectionSnapshotQuery.getBattleById(battleId);
    if (Option.isNone(battle)) {
      return;
    }
    const orchestratorThreadId = battle.value.orchestratorThreadId;
    if (orchestratorThreadId === null) {
      return;
    }

    // Guard 2: the orchestrator's own turn ending is a flush trigger, never a
    // report. Reporting it to itself would loop forever. This is also the one
    // observation that releases the in-flight mark, so the mark can only ever
    // be cleared by the turn it was set for actually finishing.
    if (threadId === orchestratorThreadId) {
      orchestratorTurnInFlight.delete(battleId);
      yield* flushReports({ battleId, orchestratorThreadId, memberThreadId: null });
      return;
    }

    const detail = yield* projectionSnapshotQuery.getThreadDetailSnapshot(threadId, {
      turnLimit: 1,
    });
    if (Option.isNone(detail)) {
      return;
    }
    const messages = detail.value.thread.messages;
    let lastUserIndex = -1;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index]?.role === "user") {
        lastUserIndex = index;
        break;
      }
    }
    const lastUserMessage = lastUserIndex >= 0 ? messages[lastUserIndex] : undefined;

    // Guard 1: only a turn this battle's orchestrator started is reportable.
    // The marker rides in the message id, so a turn the user started in a
    // member thread never nudges the manager.
    if (
      lastUserMessage === undefined ||
      battleIdFromOrchestratorSendMessageId(lastUserMessage.id) !== battleId
    ) {
      yield* publishReportSettled({
        battleId,
        memberThreadId: threadId,
        outcome: "ignored",
        deliveredFor: [],
      });
      return;
    }

    // `thread.session-set` fires more than once around a settle; matching the
    // send is the edge detector that keeps one send to one report.
    if (lastReportedSend.get(threadId) === lastUserMessage.id) {
      yield* publishReportSettled({
        battleId,
        memberThreadId: threadId,
        outcome: "ignored",
        deliveredFor: [],
      });
      return;
    }
    lastReportedSend.set(threadId, lastUserMessage.id);

    const reply = messages
      .slice(lastUserIndex + 1)
      .filter(
        (message) =>
          message.role === "assistant" && !message.streaming && message.text.trim().length > 0,
      )
      .map((message) => message.text.trim())
      .join("\n\n");

    const buffered = pendingReports.get(battleId) ?? [];
    buffered.push({
      memberThreadId: threadId,
      memberTitle: member.value.title,
      // A turn that ended without a reply is still news the orchestrator has
      // to act on, so it is reported explicitly rather than dropped.
      reply: reply.length > 0 ? reply : REPLYLESS_TURN_NOTE,
    });
    pendingReports.set(battleId, buffered);

    yield* flushReports({ battleId, orchestratorThreadId, memberThreadId: threadId });
  });

  const processInput = Effect.fn("processInput")(function* (input: ReactorInput) {
    if (input.source === "backfill") {
      yield* createOrchestratorSafely({
        battleId: input.battleId,
        projectId: input.projectId,
        source: "backfilled",
      });
      return;
    }
    if (input.event.type === "battle.orchestrator-refresh-requested") {
      yield* refreshOrchestrator({
        battleId: input.event.payload.battleId,
        previousThreadId: input.event.payload.previousOrchestratorThreadId,
      });
      return;
    }
    if (input.event.type === "battle.created") {
      yield* createOrchestratorSafely({
        battleId: input.event.payload.battleId,
        projectId: input.event.payload.projectId,
        source: "created",
      });
      return;
    }
    yield* processSessionSettled(input.event);
  });

  const processInputSafely = (input: ReactorInput) =>
    processInput(input).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.interrupt;
        }
        return Effect.logWarning("battle orchestrator reactor failed to process input", {
          source: input.source,
          subject: input.source === "domain" ? input.event.type : input.battleId,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(processInputSafely);

  /**
   * One snapshot pass over the battles that already exist. A defeated battle
   * is finished and a deleted one is gone; neither gains a manager.
   */
  const backfillOrchestrators = Effect.fn("backfillOrchestrators")(function* () {
    const snapshot = yield* projectionSnapshotQuery.getShellSnapshot();
    const candidates = snapshot.battles.filter(
      (battle) =>
        battle.deletedAt === null &&
        battle.phase !== "defeated" &&
        battle.orchestratorThreadId === null,
    );
    yield* Effect.forEach(
      candidates,
      (battle) =>
        worker.enqueue({
          source: "backfill",
          battleId: battle.id,
          projectId: battle.projectId,
        }),
      { discard: true },
    );
    // Waiting on the worker rather than creating inline is what keeps the pass
    // deterministic without a sleep, and it is also what puts a backfill entry
    // behind any `battle.created` already queued for the same battle.
    yield* worker.drain;

    // Adoption is read back from the projection instead of counted here: a
    // battle the `battle.created` path reached first is still adopted, and a
    // battle whose creation failed must not be reported as one.
    const settled = yield* projectionSnapshotQuery.getShellSnapshot();
    const bound = new Set(
      settled.battles.flatMap((battle) =>
        battle.orchestratorThreadId === null ? [] : [battle.id as string],
      ),
    );
    const adopted = candidates.filter((battle) => bound.has(battle.id)).map((battle) => battle.id);

    const now = yield* DateTime.now;
    yield* receiptBus.publish({
      type: "battle.orchestrator.backfill-settled",
      adopted,
      createdAt: DateTime.formatIso(now),
    });
  });

  const start: BattleOrchestratorReactorShape["start"] = Effect.fn("start")(function* () {
    yield* forkParked(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
        if (event.type === "battle.created") {
          return worker.enqueue({ source: "domain", event });
        }
        if (event.type === "battle.orchestrator-refresh-requested") {
          return worker.enqueue({ source: "domain", event });
        }
        if (
          event.type === "thread.session-set" &&
          isSettledSessionStatus(event.payload.session.status)
        ) {
          return worker.enqueue({ source: "domain", event });
        }
        return Effect.void;
      }),
    );

    // The domain event stream is hot, so a battle that already existed when
    // this reactor started never emits `battle.created` again. This one pass
    // is what gives those battles their manager.
    const backfill = backfillOrchestrators().pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.interrupt;
        }
        return Effect.logWarning("battle orchestrator reactor backfill failed", {
          cause: Cause.pretty(cause),
        });
      }),
    );
    const activation = yield* ServerActivation;
    if (activation === undefined) {
      yield* backfill;
    } else {
      yield* forkParked(backfill);
    }
  });

  return {
    start,
    drain: worker.drain,
  } satisfies BattleOrchestratorReactorShape;
});

export const BattleOrchestratorReactorLive = Layer.effect(BattleOrchestratorReactor, make);
