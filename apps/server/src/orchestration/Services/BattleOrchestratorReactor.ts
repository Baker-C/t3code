/**
 * BattleOrchestratorReactor - Battle manager-thread service interface.
 *
 * Owns the background worker that gives every battle exactly one orchestrator
 * thread - on creation and, for battles that predate orchestrators, on startup
 * - and that feeds a member's reply back to that orchestrator when the turn the
 * orchestrator started finishes.
 *
 * @module BattleOrchestratorReactor
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

/**
 * BattleOrchestratorReactorShape - Service API for the orchestrator reactor.
 */
export interface BattleOrchestratorReactorShape {
  /**
   * Start the orchestrator reactor and run its one startup backfill pass.
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
 * BattleOrchestratorReactor - Service tag for battle orchestrator workers.
 */
export class BattleOrchestratorReactor extends Context.Service<
  BattleOrchestratorReactor,
  BattleOrchestratorReactorShape
>()("t3/orchestration/Services/BattleOrchestratorReactor") {}
