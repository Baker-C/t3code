/**
 * BattleQueueReadinessReactor - Battle-queue action lifecycle service.
 *
 * Owns the background worker that turns raw turn activity into queue actions.
 * It is the only thing that sees work start and stop, so it does both halves:
 * it opens an action when a turn starts in a queued battle, and it settles that
 * action when its wake rule is satisfied.
 *
 * Turn settling is projection-internal and emits no event, so a session leaving
 * "starting"/"running" is the only turn-end signal on the wire — the same
 * signal `BattleOrchestratorReactor` keys on.
 *
 * @module BattleQueueReadinessReactor
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

/**
 * BattleQueueReadinessReactorShape - Service API for the readiness reactor.
 */
export interface BattleQueueReadinessReactorShape {
  /**
   * Start the reactor.
   *
   * The returned effect must be run in a scope so the worker fiber can be
   * finalized on shutdown.
   */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;

  /**
   * Resolves when the internal processing queue is empty and idle.
   * Intended for test use to replace timing-sensitive sleeps.
   */
  readonly drain: Effect.Effect<void>;
}

/**
 * BattleQueueReadinessReactor - Service tag for the queue readiness worker.
 */
export class BattleQueueReadinessReactor extends Context.Service<
  BattleQueueReadinessReactor,
  BattleQueueReadinessReactorShape
>()("t3/orchestration/Services/BattleQueueReadinessReactor") {}
