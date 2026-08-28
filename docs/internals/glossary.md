# Glossary

> For maintainers. Using T3 Code? See [docs/user](../user/).

This is a living glossary for T3 Code. It explains what common terms mean in this codebase.

## Table of contents

- [Project and workspace](#project-and-workspace)
- [Thread timeline](#thread-timeline)
- [Orchestration](#orchestration)
- [Battles](#battles)
- [Battle queue](#battle-queue)
- [Provider runtime](#provider-runtime)
- [Checkpointing](#checkpointing)

## Concepts

### Project and workspace

#### Project

The top-level workspace record in the app. In [the orchestration contracts][1], a project has a `workspaceRoot` and a title. It does not contain threads: `OrchestrationProject` and `OrchestrationThread` are separate arrays on the read model, and a project can have zero threads. See [workspace-layout.md][2].

#### Workspace root

The root filesystem path for a project. In [the orchestration model][1], it is the base directory for branches and optional worktrees. See [workspace-layout.md][2].

#### Worktree

A Git worktree used as an isolated workspace for a thread. If a thread has a `worktreePath` in [the contracts][1], it runs there instead of in the main working tree. Git operations live behind the VCS driver contract in `apps/server/src/vcs/VcsDriver.ts`, implemented by [GitVcsDriverCore.ts][3].

### Thread timeline

#### Thread

The main durable unit of conversation and workspace history. In [the orchestration contracts][1], a thread holds messages, activities, checkpoints, and session-related state. See [projector.ts][4].

#### Turn

A single user-to-assistant work cycle inside a thread. It starts with user input and ends when the session leaves `running` status, which [projector.ts][4] treats as the authoritative completion signal (`settledTurnStateForSessionStatus`). Checkpoint and diff work may settle afterward without changing when the turn ended. See [the contracts][1] and [ProviderRuntimeIngestion.ts][5].

#### Activity

A user-visible log item attached to a thread. In [the contracts][1], activities cover important non-message events like approvals, tool actions, and failures. They are projected into thread state in [projector.ts][4].

### Orchestration

Orchestration is the server-side domain layer that turns runtime activity into stable app state. The main entry point is [OrchestrationEngine.ts][7], with core logic in [decider.ts][8] and [projector.ts][4].

#### Aggregate

The domain object a command or event belongs to. In [the contracts][1], that is `project`, `thread`, or `battle`. See [decider.ts][8].

#### Command

A typed request to change domain state. In [the contracts][1], commands are validated in [commandInvariants.ts][9] and turned into events by [decider.ts][8].
Examples include `thread.create`, `thread.turn.start`, and `thread.checkpoint.revert`.

#### Domain Event

A persisted fact that something already happened. In [the contracts][1], events are the source of truth, and [projector.ts][4] shows how they are applied.
Examples include `thread.created`, `thread.message-sent`, and `thread.turn-diff-completed`.

#### Decider

The pure orchestration logic that turns commands plus current state into events. The core implementation is in [decider.ts][8], with preconditions in [commandInvariants.ts][9].

#### Projection

A read-optimized view derived from events. See [projector.ts][4], [ProjectionPipeline.ts][11], and [ProjectionSnapshotQuery.ts][10].

#### Projector

The logic that applies domain events to the read model or projection tables. See [projector.ts][4] and [ProjectionPipeline.ts][11].

#### Read model

The current materialized view of orchestration state. In [the contracts][1], it holds projects, threads, messages, activities, checkpoints, and session state. See [ProjectionSnapshotQuery.ts][10] and [OrchestrationEngine.ts][7].

#### Reactor

A side-effecting service that handles follow-up work after events or runtime signals. Examples include [CheckpointReactor.ts][6], [ProviderCommandReactor.ts][12], and [ProviderRuntimeIngestion.ts][5].

#### Receipt

A typed signal emitted when an async milestone completes, such as `checkpoint.baseline.captured`, `checkpoint.diff.finalized`, or `turn.processing.quiesced`. Receipts are a test-only mechanism: the production `RuntimeReceiptBusLive` publish is a no-op and only the test layer is PubSub-backed. Do not build production behavior on them. See [RuntimeReceiptBus.ts][13] and [CheckpointReactor.ts][6].

#### Quiesced

"Quiesced" means a turn has gone quiet and stable: follow-up work such as [CheckpointReactor.ts][6] has settled. It appears in [the receipt schema][13], so in practice it is something tests wait on rather than a production signal.

### Battles

Battles group threads under one goal. The aggregate lives beside `project` and `thread` in [the contracts][1], with commands decided in [decider.ts][8] and folded into the read model by [projector.ts][4]. See [the user-facing page][25].

#### Battle

An orchestration aggregate holding a goal, a list of victory conditions, and a phase. It owns no branch and no worktree: membership lives on the thread's immutable `battleId`, so one battle can span several worktrees (a frontend and a backend checkout inside one project) and several threads can share one. Preconditions are in [commandInvariants.ts][9]; the projection row is written by [ProjectionPipeline.ts][11] through [ProjectionBattles.ts][26].

A battle carries an immutable `slug`, derived from its title once at creation in [decider.ts][8]. Battle-derived branch names are built from the stored slug, so renaming a battle never drifts the branches its threads already sit on.

#### Victory condition

A unit of battle scope, not of completion: it is met once its plan is pinned (`scoped`), before any implementation lands. In [the contracts][1] the states are `unscoped`, `scoping`, `scoped`, and `descoped`. Conditions are stored inline on the battle rather than as their own aggregate — the list is small and is always read with its battle. Each carries `updatedByThreadId`, the thread whose agent or user last changed it, which is how MCP edits stay attributable. See [the battle toolkit handlers][27].

#### Battle lines drawn

Derived state, not a stored phase: every condition is resolved (`scoped` or `descoped`) and at least one survived. The helper is `battleLinesDrawn` in [the contracts][1], shared by the server and the clients. Entering the `fighting` phase is an explicit `battle.declare-fighting` command guarded by it, so a battle whose conditions were all struck can never start fighting.

#### Defeated

The terminal battle phase, entered by `battle.declare-defeat`. The event carries the user's explicit `retireWorktrees` choice — the server never guesses which worktrees to remove — and a `defeatedAt` stamp. `battle.reopen` returns the battle to `fighting` and clears both. Reopening is lazy: nothing is re-provisioned until a member thread next starts a turn. See [decider.ts][8].

#### Orchestrator thread

The battle's manager thread, one per battle and never two: `battle.orchestrator.set` is server-only and the decider refuses it once `orchestratorThreadId` is set. [BattleOrchestratorReactor.ts][30] creates it on `battle.created` and adopts, in one startup pass, every live battle that still reads null — which is how battles that predate orchestrators get one without a data migration.

It is a manager, not a fighter: no branch, no worktree, no checkpoints. `worktreePath: null` resolves to the project root, so it shares a [TurnGate](#turngate) permit with local-mode threads there. It is enlisted in its battle like any member, and the clients hide it from every thread list by deriving the orchestrator ids from the battles already in the shell — no new thread field. A direct URL still opens it; that is an escape hatch, not a surface.

#### Report-back

How a member's reply reaches the orchestrator. `battle_thread_send` is asynchronous: it returns as soon as the turn is dispatched, and when that turn settles [BattleOrchestratorReactor.ts][30] starts one orchestrator turn carrying the reply.

Turn settling is projection-internal and emits no event, so the reactor triggers on `thread.session-set` leaving the `running` status and reads the settled turn back through [ProjectionSnapshotQuery.ts][31]. Attribution rides on the message id, minted by `orchestratorSendMessageId` in [battleOrchestrator.ts][32] — a durable marker in the event log rather than reactor memory, so a restart cannot mistake a user's turn for the orchestrator's.

Four guards, all load-bearing: only orchestrator-initiated turns report; the orchestrator's own turns never report themselves; reports arriving while the orchestrator is mid-turn coalesce into one delivery; and a report never starts a member turn by itself — only a tool call does that.

#### TurnGate

Per-key mutual exclusion for provider turns, in [TurnGate.ts][28]. The key is the thread's resolved working directory (`worktreePath`, else the project's workspace root), **not** the battle id: two battle threads in different worktrees run concurrently, while two threads sharing one worktree serialize even across battles. The permit is held for the whole turn fiber and released on completion, failure, or interruption. Waiting threads surface as `thread.turnQueued` in the read model. Whether a cwd is shared is answered by [SharedWorktree.ts][29], which also drives the shared-cwd checkpoint policy: pre-turn refs, pre→post turn diffs, and a revert guard.

### Battle queue

An environment-scoped, priority-ordered working set of battles: what the user is cycling through right now. A fourth orchestration aggregate beside `project`, `thread` and `battle`, with its own `queue` aggregate kind in [the contracts][1]. See [the user-facing page][33].

#### Queue entry

One battle's slot. A battle appears exactly once no matter how many actions it holds, which is what keeps the list short enough to cycle quickly. Rows are removed outright rather than tombstoned — the queue is deliberately disposable and the battle is the durable record. The projection row is written by [ProjectionPipeline.ts][11] through [ProjectionQueueEntries.ts][34].

Auto-drop on `battle.declare-defeat` and `battle.delete` is decided in [decider.ts][8] rather than by a reactor, so the drop is atomic with the phase change: there is no window in which the queue points at a battle that is gone. `battle.reopen` deliberately does **not** re-add.

#### Action

A unit of kicked-off work inside a battle: the threads one hand-off put in flight, plus its wake rule. Created by work _starting_, never by a thread existing — a battle with five idle threads has no actions. Actions ride inline on the entry as JSON, like victory conditions do on a battle.

[BattleQueueReadinessReactor.ts][35] owns both halves. It opens an action on `thread.turn-start-requested` for a thread in a queued battle, forming it around that thread's authored [group](#thread-group) rather than the single thread, and widening the open action when a second thread of the same group starts. It settles the action when the wake rule fires, reading state back through [ProjectionSnapshotQuery.ts][31] — turn settling emits no event, so it triggers on `thread.session-set` leaving `running`, the same signal [report-back](#report-back) uses.

There is no startup backfill: work that started before the reactor did has already ended, and reconstructing actions for it would invent hand-offs the user never made.

#### Wake rule

What makes an action available again: `all` (every thread idle and awaiting input), `any` (the first thread back), or `thread` (one named thread, which must be in the action). `all` is the default and reproduces the base availability rule exactly; the others relax it. Authored either in the battle UI or by the orchestrator through `battle_queue_action_wake_rule_set` in [the battle toolkit handlers][27].

A thread waiting on a [TurnGate](#turngate) permit counts as busy, so its action simply waits longer. There is no separate "blocked" state — from the queue's point of view a thread is either working or wanting you.

#### Action outcome

How a settled action wants you: `completed`, `needs-clarification`, or `errored`. All three count as ready. `errored` wins the derivation because it is the one that must not be missed, and it is marked on the row — but it never promotes the row out of its tier, because a failure must not override the user's judgement about what matters.

#### Thread group

The authored partition of a battle's threads into hand-off units, stored on the battle. Stored **sparsely**: only groups holding more than one thread are kept, so a thread no group names is in a group of its own and enlisting a thread needs no write. Two authors write the same `battle.thread-groups.set` command — drag-and-drop in the battle UI, and `battle_thread_group_set` in [the battle toolkit handlers][27] — so there is one source of truth and no merge.

#### Compounded priority

Project priority plus battle priority, each 0–3, giving 0–6. `0` means _unset_, not lowest. The two are summed rather than ranked lexicographically, so a top-priority personal battle can beat a low-priority work one. The score is never surfaced: the UI shows the ordering only. Ordering, merging across environments, and the settings flags that switch a dimension off all live in `battleQueue.ts` in [client-runtime][36], shared by web and mobile.

#### Lap

One pass of the cycle button through every eligible battle. A skipped battle is passed over for the rest of the lap; when no eligible battle remains unskipped the lap resets and every skip clears. The reset is decided in the same breath as the skip that exhausts it, so the cycle button is never briefly dead.

A fresh readiness signal clears a battle's skip early — new work is new information, so it earns its place back in the lap.

The degenerate case is real: with exactly one eligible battle, skipping it is also the skip that ends the lap, so it clears itself immediately. The UI disables the skip control rather than letting it no-op; see `queueSkipAvailability` in [client-runtime][36].

### Provider runtime

The live backend agent implementation and its event stream. The main service is [ProviderService.ts][14], the adapter contract is [ProviderAdapter.ts][15], and the overview is in [providers.md][16].

#### Provider

The backend agent runtime that actually performs work. Five drivers ship built in: Codex, Claude, Cursor, Grok, and OpenCode. See [ProviderService.ts][14], [ProviderAdapter.ts][15], and [CodexAdapter.ts][17] as a representative adapter.

#### Session

The live provider-backed runtime attached to a thread. Session shape is in [the orchestration contracts][1], and lifecycle is managed in [ProviderService.ts][14].

#### Runtime mode

The safety/access mode for a thread or session. [The contracts][1] define four values: `approval-required`, `auto-accept-edits`, `auto`, and `full-access`. See [permission modes][18].

#### Interaction mode

The agent interaction style for a thread. In [the contracts][1], the values are `default` and `plan`.

#### Assistant delivery mode

Controls how assistant text reaches the thread timeline. In [the contracts][1], `streaming` updates incrementally and `buffered` accumulates text. Buffered delivery is not held until the turn completes: it spills once accumulated text would exceed 24,000 characters, and flushes at approval and user-input boundaries. See [ProviderRuntimeIngestion.ts][5].

#### Snapshot

A point-in-time view of state. The word is used in multiple layers, including orchestration, provider, and checkpointing. See [ProjectionSnapshotQuery.ts][10], [ProviderAdapter.ts][15], and [CheckpointStore.ts][19].

### Checkpointing

Checkpointing captures workspace state over time so the app can diff turns and restore earlier points. The main pieces are [CheckpointStore.ts][19], [CheckpointDiffQuery.ts][20], and [CheckpointReactor.ts][6].

#### Checkpoint

A saved snapshot of a thread workspace at a particular turn. In practice it is a hidden Git ref in [CheckpointStore.ts][19] plus a projected summary from [ProjectionCheckpoints.ts][21]. Capture and lifecycle work happen in [CheckpointReactor.ts][6].

#### Checkpoint ref

The durable identifier for a filesystem checkpoint, stored as a Git ref. It is typed in [the contracts][1], constructed in [Utils.ts][22], and used by [CheckpointStore.ts][19].

#### Checkpoint baseline

The starting checkpoint for diffing a thread timeline. This flow is surfaced through [RuntimeReceiptBus.ts][13], coordinated in [CheckpointReactor.ts][6], and supported by [Utils.ts][22].

#### Checkpoint diff

The patch difference between two checkpoints. Query logic lives in [CheckpointDiffQuery.ts][20], diff parsing lives in [Diffs.ts][23], and finalization is coordinated by [CheckpointReactor.ts][6].

#### Turn diff

The file patch and changed-file summary for one turn. It is usually computed in [CheckpointDiffQuery.ts][20], represented in [the contracts][1], and recorded into thread state by [projector.ts][4].

## Practical Shortcuts

- If you see `requested`, think "intent recorded".
- If you see `completed`, think "result applied".
- If you see `receipt`, think "async milestone signal, for tests".
- If you see `checkpoint`, think "workspace snapshot for diff/restore".
- If you see `quiesced`, think "all relevant follow-up work has gone idle".
- If you see `scoped`, think "the plan is pinned", not "the work is finished".

## Related Docs

- [Architecture overview][24]
- [Provider architecture][16]
- [Permission modes][18]
- [Workspace layout][2]

[1]: ../../packages/contracts/src/orchestration.ts
[2]: ./workspace-layout.md
[3]: ../../apps/server/src/vcs/GitVcsDriverCore.ts
[4]: ../../apps/server/src/orchestration/projector.ts
[5]: ../../apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts
[6]: ../../apps/server/src/orchestration/Layers/CheckpointReactor.ts
[7]: ../../apps/server/src/orchestration/Layers/OrchestrationEngine.ts
[8]: ../../apps/server/src/orchestration/decider.ts
[9]: ../../apps/server/src/orchestration/commandInvariants.ts
[10]: ../../apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts
[11]: ../../apps/server/src/orchestration/Layers/ProjectionPipeline.ts
[12]: ../../apps/server/src/orchestration/Layers/ProviderCommandReactor.ts
[13]: ../../apps/server/src/orchestration/Services/RuntimeReceiptBus.ts
[14]: ../../apps/server/src/provider/Layers/ProviderService.ts
[15]: ../../apps/server/src/provider/Services/ProviderAdapter.ts
[16]: ./providers.md
[17]: ../../apps/server/src/provider/Layers/CodexAdapter.ts
[18]: ../user/permission-modes.md
[19]: ../../apps/server/src/checkpointing/CheckpointStore.ts
[20]: ../../apps/server/src/checkpointing/CheckpointDiffQuery.ts
[21]: ../../apps/server/src/persistence/Services/ProjectionCheckpoints.ts
[22]: ../../apps/server/src/checkpointing/Utils.ts
[23]: ../../apps/server/src/checkpointing/Diffs.ts
[24]: ./overview.md
[25]: ../user/battles.md
[26]: ../../apps/server/src/persistence/Layers/ProjectionBattles.ts
[27]: ../../apps/server/src/mcp/toolkits/battle/handlers.ts
[28]: ../../apps/server/src/provider/TurnGate.ts
[29]: ../../apps/server/src/checkpointing/SharedWorktree.ts
[30]: ../../apps/server/src/orchestration/Layers/BattleOrchestratorReactor.ts
[31]: ../../apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts
[32]: ../../apps/server/src/orchestration/battleOrchestrator.ts
[33]: ../user/battle-queue.md
[34]: ../../apps/server/src/persistence/Layers/ProjectionQueueEntries.ts
[35]: ../../apps/server/src/orchestration/Layers/BattleQueueReadinessReactor.ts
[36]: ../../packages/client-runtime/src/state/battleQueue.ts
