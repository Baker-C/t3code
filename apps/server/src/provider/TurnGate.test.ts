import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import { makeTurnGate } from "./TurnGate.ts";

it.effect("runs immediately without queue callbacks when the key is free", () =>
  Effect.gen(function* () {
    const gate = yield* makeTurnGate;
    const events: Array<string> = [];
    const result = yield* gate.withTurnPermit({
      key: "/tmp/worktree-a",
      onQueued: Effect.sync(() => events.push("queued")),
      onAcquired: Effect.sync(() => events.push("acquired")),
    })(Effect.succeed("ran"));
    expect(result).toBe("ran");
    expect(events).toEqual([]);
  }),
);

it.effect("serializes same-key turns and fires queued/acquired for the waiter", () =>
  Effect.gen(function* () {
    const gate = yield* makeTurnGate;
    const events: Array<string> = [];
    const firstRunning = yield* Deferred.make<void>();
    const releaseFirst = yield* Deferred.make<void>();

    const first = yield* gate
      .withTurnPermit({ key: "shared" })(
        Deferred.succeed(firstRunning, undefined).pipe(
          Effect.andThen(Deferred.await(releaseFirst)),
          Effect.andThen(Effect.sync(() => events.push("first-done"))),
        ),
      )
      .pipe(Effect.forkChild);
    yield* Deferred.await(firstRunning);

    const queuedSeen = yield* Deferred.make<void>();
    const second = yield* gate
      .withTurnPermit({
        key: "shared",
        onQueued: Effect.sync(() => events.push("queued")).pipe(
          Effect.andThen(Deferred.succeed(queuedSeen, undefined)),
        ),
        onAcquired: Effect.sync(() => events.push("acquired")),
      })(Effect.sync(() => events.push("second-done")))
      .pipe(Effect.forkChild);

    // The waiter reports queued before the holder releases.
    yield* Deferred.await(queuedSeen);
    expect(events).toEqual(["queued"]);

    yield* Deferred.succeed(releaseFirst, undefined);
    yield* Fiber.join(first);
    yield* Fiber.join(second);
    expect(events).toEqual(["queued", "first-done", "acquired", "second-done"]);
  }),
);

it.effect("different keys run concurrently", () =>
  Effect.gen(function* () {
    const gate = yield* makeTurnGate;
    const aRunning = yield* Deferred.make<void>();
    const releaseA = yield* Deferred.make<void>();
    const bDone = yield* Deferred.make<void>();

    const a = yield* gate
      .withTurnPermit({ key: "frontend" })(
        Deferred.succeed(aRunning, undefined).pipe(Effect.andThen(Deferred.await(releaseA))),
      )
      .pipe(Effect.forkChild);
    yield* Deferred.await(aRunning);

    yield* gate.withTurnPermit({ key: "backend" })(Deferred.succeed(bDone, undefined));
    expect(yield* Deferred.isDone(bDone)).toBe(true);

    yield* Deferred.succeed(releaseA, undefined);
    yield* Fiber.join(a);
  }),
);

it.effect("interrupting the holder releases the permit to the waiter", () =>
  Effect.gen(function* () {
    const gate = yield* makeTurnGate;
    const holderRunning = yield* Deferred.make<void>();
    const waiterDone = yield* Deferred.make<void>();

    const holder = yield* gate
      .withTurnPermit({ key: "shared" })(
        Deferred.succeed(holderRunning, undefined).pipe(Effect.andThen(Effect.never)),
      )
      .pipe(Effect.forkChild);
    yield* Deferred.await(holderRunning);

    const waiter = yield* gate
      .withTurnPermit({ key: "shared" })(Deferred.succeed(waiterDone, undefined))
      .pipe(Effect.forkChild);

    yield* Fiber.interrupt(holder);
    yield* Fiber.join(waiter);
    expect(yield* Deferred.isDone(waiterDone)).toBe(true);
  }),
);

it.effect("interrupting a waiter leaves the key usable for the next turn", () =>
  Effect.gen(function* () {
    const gate = yield* makeTurnGate;
    const holderRunning = yield* Deferred.make<void>();
    const releaseHolder = yield* Deferred.make<void>();
    const thirdDone = yield* Deferred.make<void>();

    const holder = yield* gate
      .withTurnPermit({ key: "shared" })(
        Deferred.succeed(holderRunning, undefined).pipe(
          Effect.andThen(Deferred.await(releaseHolder)),
        ),
      )
      .pipe(Effect.forkChild);
    yield* Deferred.await(holderRunning);

    const waiter = yield* gate
      .withTurnPermit({ key: "shared" })(Effect.void)
      .pipe(Effect.forkChild);
    yield* Fiber.interrupt(waiter);

    yield* Deferred.succeed(releaseHolder, undefined);
    yield* Fiber.join(holder);

    yield* gate.withTurnPermit({ key: "shared" })(Deferred.succeed(thirdDone, undefined));
    expect(yield* Deferred.isDone(thirdDone)).toBe(true);
  }),
);
