/**
 * BattleRetirementReactor - Worktree retirement service interface.
 *
 * Owns the background worker that reacts to a battle being defeated and, when
 * the user asked for it, retires the worktrees its member threads no longer
 * need.
 *
 * @module BattleRetirementReactor
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

/**
 * BattleRetirementReactorShape - Service API for the retirement reactor.
 */
export interface BattleRetirementReactorShape {
  /**
   * Start the retirement reactor.
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
 * BattleRetirementReactor - Service tag for battle retirement workers.
 */
export class BattleRetirementReactor extends Context.Service<
  BattleRetirementReactor,
  BattleRetirementReactorShape
>()("t3/orchestration/Services/BattleRetirementReactor") {}
