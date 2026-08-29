# Battle queue architecture

The queue is a fourth orchestration aggregate beside `project`, `thread` and `battle`. This page
covers the decisions that are not obvious from the types. Vocabulary is in
[the glossary](./glossary.md#battle-queue); the user-facing behaviour is in
[docs/user/battle-queue.md](../user/battle-queue.md).

## Why an aggregate rather than client state

The queue follows the user between devices, so it cannot live in client storage. It is
environment-scoped by construction rather than by rule: entries point at battles, battles belong to
projects, and projects belong to one environment. Nothing enforces the scoping because nothing can
violate it.

Clients hold several environments at once, so the merged list is a client-side union with no
syncing and no reconciliation. Each queue stays owned by its environment and work always executes
where it lives. Merging, ordering and cycling are pure functions in
`packages/client-runtime/src/state/battleQueue.ts`, shared by web and mobile.

## Aggregate ids

Entry-scoped events (`queue.entry-added`, `queue.action-*`, …) use `aggregateKind: "queue"` with the
**battle id** as the aggregate id, so one battle's queue history reads as one stream.

`queue.lap-reset` is the exception: the lap is queue-wide, so it files under the constant
`BATTLE_QUEUE_AGGREGATE_ID`. That constant is a `QueueId`, which is why the event store's
`aggregateId` union has a fourth member.

This split matters for the shell stream, which coalesces by `${aggregateKind}:${aggregateId}`.
Entry events and the lap reset land in different buckets, so a lap reset can never clobber a
pending entry update.

## Where the auto-drop lives

`battle.declare-defeat` and `battle.delete` each decide into their own event **plus** a
`queue.entry-removed`, in `decider.ts`. It could have been a reactor; it is not, because the decider
makes the drop atomic with the phase change. A reactor would leave a window in which the queue
points at a battle that is defeated or gone.

This is safe precisely because there is no automatic notion of a battle being complete. Entering
`fighting` is gated on `battleLinesDrawn`, and defeat is an explicit human declaration carrying a
`retireWorktrees` choice. A human always declares it, so the queue can trust the signal.

`battle.reopen` deliberately does not re-add. That matches how reopen behaves everywhere else:
nothing is re-provisioned until a member thread next starts a turn.

## The readiness reactor

`BattleQueueReadinessReactor` owns both halves of an action's life, through one `DrainableWorker`
so a kick-off and the settle that follows it can never interleave. That serialization is what lets
it read the queue, decide and write without a lock.

**Opening.** On `thread.turn-start-requested` for a thread in a queued battle, it opens an action
around that thread's authored group rather than the single thread — the group is the unit you hand
off as one piece. A second thread of the same group starting _widens_ the open action instead of
opening a rival one, which is what keeps one hand-off to one row.

**Settling.** Turn settling is projection-internal and emits no event, so the only turn-end signal
on the wire is `thread.session-set` leaving `starting`/`running`. That is the same signal
`BattleOrchestratorReactor` keys on, and the two reactors deliberately mirror each other's comment
on the point.

There is no startup backfill. Work that started before the reactor did has already ended;
reconstructing actions for it would invent hand-offs the user never made.

Every decision publishes a `battle.queue.readiness-settled` receipt — `opened`, `widened`,
`settled`, `waiting` or `ignored` — so tests wait on the exact point the reactor decided rather than
proving a negative with a timeout.

## Wake rules and the "one rule"

The design states availability as "every thread in the action is idle and awaiting user input", and
separately offers wake rules of any/all/specific. These are unified rather than layered: the wake
rule **is** the readiness predicate, and its default `all` reproduces the base rule exactly.
Relaxing is opt-in, and nothing has to consult the UI or the orchestrator to get a correct default.

A thread waiting on a `TurnGate` permit counts as busy. From the queue's point of view that is just
a flavour of busy — there is no "blocked" state, because a thread is either working or wanting you.

## Optional fields

`priority`, `threadGroups` and `queueEntries` are `Schema.optional` rather than defaulted, matching
how `isOrchestrator`, `turnQueued` and the snooze/pin fields were added to these same aggregates.
Readers take the default through `resolveQueuePriority` and `resolveQueueEntries`, which they need
anyway because `0` already means "unset". The projection rows keep them required: the migration
gives every row a value.

## The degenerate lap

With exactly one eligible battle, skipping it is also the skip that offers every eligible battle
once — so the lap ends and the skip clears itself in the same breath. The row comes straight back.

The decider stays permissive here: the behaviour is consistent, and refusing would turn a harmless
command from an older client into an error. The UI is the gate. `queueSkipAvailability` disables the
skip control and names which of five reasons applies, so the disabled button can say why instead of
being unexplained.

## Testing

Backend behaviour is covered by `decider.battleQueue.test.ts`, `projector.battleQueue.test.ts` and
`BattleQueueReadinessReactor.test.ts`; ordering, cycling and skip availability by
`battleQueue.test.ts` in client-runtime; the sidebar section's shape by
`BattleQueueSection.test.tsx` in web. The reactor tests wait on receipts and worker drains, never
on sleeps.

## The sidebar section

The queue renders above the sidebar's search row, which is the fixed header, so it never scrolls
away while you move through projects. That placement is why it carries its own max-height and
scroll: anything in the fixed region competes with the project list for the same viewport, and an
expanded queue would otherwise push the list off screen.

Only one battle is featured — `selectNextQueueRow`'s answer — and it doubles as the Next control,
so there is no button. With nothing ready that selector returns null, and the section falls back to
the first three rows in queue order rather than rendering an empty slot.

There is no main-list/queued-actions split. A battle with nothing settled reads as `working` and
sits in the same list, which is why `visibleQueueRows` and `queuedQueueRows` are gone: they existed
only to feed two sections that are now one.
