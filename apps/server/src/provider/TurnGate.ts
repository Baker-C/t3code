/**
 * TurnGate - per-key mutual exclusion for provider turns.
 *
 * Threads that share a working directory (battle members sharing a worktree,
 * or plain local-mode threads on one project root) must not run turns
 * concurrently: captures tear, diffs cross-attribute, and restores clobber.
 * The gate holds one permit per key (the thread's resolved cwd) for the full
 * lifetime of the turn effect, so release is tied to fiber exit - completion,
 * failure, or interruption - and never depends on a turn-end command.
 *
 * Entries are reference-counted and dropped when no fiber holds or awaits
 * them, so the map never grows with dead cwds.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";

interface TurnGateEntry {
  readonly semaphore: Semaphore.Semaphore;
  users: number;
}

export interface TurnGate {
  /**
   * Runs `turn` while holding the exclusive permit for `key`. When the permit
   * is not immediately available, `onQueued` runs before waiting and
   * `onAcquired` runs once the permit is obtained (both while the caller is
   * already inside its own fiber, so queueing never blocks the enqueuing
   * worker).
   */
  readonly withTurnPermit: (input: {
    readonly key: string;
    readonly onQueued?: Effect.Effect<void>;
    readonly onAcquired?: Effect.Effect<void>;
  }) => <A, E, R>(turn: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
}

/**
 * Normalizes a workspace path into a gate key so the same directory always
 * maps to one permit: forward slashes, no trailing slash, case-folded drive
 * letter on Windows-style paths.
 */
export const normalizeTurnGateKey = (cwd: string): string => {
  let key = cwd.replaceAll("\\", "/");
  while (key.length > 1 && key.endsWith("/")) {
    key = key.slice(0, -1);
  }
  if (/^[A-Za-z]:/.test(key)) {
    key = key.charAt(0).toLowerCase() + key.slice(1);
  }
  return key;
};

export const makeTurnGate: Effect.Effect<TurnGate> = Effect.sync(() => {
  const entries = new Map<string, TurnGateEntry>();

  const acquireEntry = (key: string): TurnGateEntry => {
    const existing = entries.get(key);
    if (existing) {
      existing.users += 1;
      return existing;
    }
    const created: TurnGateEntry = { semaphore: Semaphore.makeUnsafe(1), users: 1 };
    entries.set(key, created);
    return created;
  };

  const releaseEntry = (key: string, entry: TurnGateEntry): void => {
    entry.users -= 1;
    if (entry.users <= 0) {
      entries.delete(key);
    }
  };

  const withTurnPermit: TurnGate["withTurnPermit"] =
    (input) =>
    <A, E, R>(turn: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
      Effect.suspend(() => {
        const entry = acquireEntry(input.key);
        return entry.semaphore
          .withPermitsIfAvailable(1)(turn)
          .pipe(
            Effect.flatMap((ran) =>
              Option.isSome(ran)
                ? Effect.succeed(ran.value)
                : (input.onQueued ?? Effect.void).pipe(
                    Effect.andThen(
                      entry.semaphore.withPermit(
                        (input.onAcquired ?? Effect.void).pipe(Effect.andThen(turn)),
                      ),
                    ),
                  ),
            ),
            Effect.ensuring(Effect.sync(() => releaseEntry(input.key, entry))),
          );
      });

  return { withTurnPermit };
});
