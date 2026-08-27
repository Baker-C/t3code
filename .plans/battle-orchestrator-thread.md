# Battle orchestrator thread

Additive scope for the battle `926dc291-4aa0-4703-b138-04b60e11933d` ("Battle upgrades: battle
page"). It builds on `.plans/battle-detail-page.md`, whose work sits uncommitted in the tree.

**The two ship together.** The battle page is the orchestrator thread's page, so there is one
feature here and one shipment. Build on the uncommitted battle page rather than beside it: the
route, the data wiring, the condition rendering and the thread rows all survive, and the layout is
what changes.

## Objective

Give every battle one **orchestrator thread**. The orchestrator is the battle's manager: it reads
the battle, messages the member threads, reads what they answered, and edits the victory
conditions. The user can run the whole battle from it, or open a member thread and work there
directly.

The orchestrator does not appear in any normal thread list. Its home is the battle page: the battle
context sits pinned at the top, the orchestrator transcript runs below it, and the composer sits at
the bottom. The battle page becomes a chat page with the battle context above it.

## Decisions

| Decision            | Choice                                                                                                                                          |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Reply model         | Async send, then automatic report-back. `battle_thread_send` returns immediately. When the turn it started finishes, a reactor feeds the reply to the orchestrator. |
| Orchestrator scope  | Manager only. No branch, no worktree, no checkpoints. It runs on the project root.                                                               |
| Page layout         | A fixed overlay at the top of the page, not a scrolling header. Centered, one step larger type, hiding away to title plus thread list.           |
| Refresh             | One button archives the current orchestrator and starts a fresh one. The flag `isOrchestrator` keeps retired ones hidden.                        |
| Creation            | Eager. A reactor creates the orchestrator when the battle is created, and backfills battles that have none.                                      |

## Facts from the codebase audit (2026-08-23)

- Battle membership is `thread.battleId`, immutable at creation (`contracts/orchestration.ts:455`).
  A battle owns no threads. `OrchestrationBattle` has no thread field yet
  (`contracts/orchestration.ts:290`).
- The decider can return more than one event per command (see `thread.turn.start` in `decider.ts`),
  and `thread.turn.start` has **no** guard against a busy target. Serialization is the job of
  `ProviderCommandReactor` and `TurnGate` (`provider/TurnGate.ts`), which holds one permit per
  resolved cwd. A send to a busy thread therefore queues; it does not fail.
- A thread with `worktreePath: null` runs on the project root (`worktreePath ?? workspaceRoot`,
  `ws.ts:2021`). No schema change is needed for a worktree-less thread.
- A turn settles when the session status leaves `running` (`settledTurnStateForSessionStatus`,
  `ProjectionPipeline.ts:75`) or when a non-streaming `thread.message-sent` lands while the turn is
  no longer running (`ProjectionPipeline.ts:1494`). These two are the report-back trigger.
- `BattleRetirementReactor` (`orchestration/Layers/BattleRetirementReactor.ts`) is the precedent for
  a reactor that watches the event stream, dispatches commands, and publishes receipts through
  `RuntimeReceiptBus`.
- MCP capabilities are minted per thread in `McpSessionRegistry.resolveCapabilities`
  (`mcp/McpSessionRegistry.ts:135`). The `battle` capability needs `enableBattleTools` **and** a
  thread that is in a battle. The battle toolkit resolves the battle from the caller's own thread,
  which is what makes an id in a prompt unable to redirect it (`battle/handlers.ts`,
  `requireBattleScope`).
- The client shell already streams every battle (`OrchestrationShellSnapshot.battles`). That alone
  would identify the *current* orchestrator without a new thread field, but not a retired one, which
  is why section 1 adds `isOrchestrator` to the thread.
- `ChatView` (`apps/web/src/components/ChatView.tsx`, 6832 lines) takes `routeKind: "server" |
"draft"` and has no slot for caller-supplied content. `MessagesTimeline` renders through LegendList,
which owns its own scrolling, so there is no shared scroll container a header could sit in.

## Changes

### 1. Contracts (`packages/contracts/src/orchestration.ts`)

- `OrchestrationBattle` gets `orchestratorThreadId: Schema.optional(Schema.NullOr(ThreadId))` —
  which thread is the battle's orchestrator **right now**. Optional, so snapshots written before
  this change still decode.
- `OrchestrationThread` and `OrchestrationThreadShell` both get
  `isOrchestrator: Schema.optional(Schema.Boolean)`, set by `ThreadCreateCommand`.

  This flag is what the clients filter on, and it exists **because the orchestrator is
  replaceable**. A retired orchestrator is no longer the battle's `orchestratorThreadId`, so a
  filter keyed on that id alone would let every past orchestrator reappear in the sidebar as an
  ordinary member thread. The flag stays true for the thread's whole life, so a thread that was
  ever an orchestrator never surfaces as a member.
- New command `battle.orchestrator.set { commandId, battleId, threadId }` and new event
  `battle.orchestrator-set`. The decider accepts it when the battle has no orchestrator, and when
  it replaces one — replacement is the refresh path in section 7. It refuses a `threadId` that is
  not in the battle, or that is not flagged `isOrchestrator`.
- Add `battle.orchestrator-set` to `OrchestrationEventType` and to the battle command unions.

### 2. Orchestrator creation (`apps/server/src/orchestration/Layers/BattleOrchestratorReactor.ts`)

- On `battle.created`, dispatch `thread.create` with `battleId` set, `branch: null`,
  `worktreePath: null`, and the title `Orchestrator`. Then dispatch `battle.orchestrator.set`.
- On startup, do one backfill pass: every battle that is not deleted, is not defeated, and has
  `orchestratorThreadId === null` gets the same treatment. This is what gives the current in-flight
  battle its orchestrator.
- Publish a receipt for both paths so the tests wait on the receipt and not on a timer.

### 3. Cross-thread tools (`apps/server/src/mcp/toolkits/battle/`)

New capability `battle-orchestrator`. `resolveCapabilities` grants it only when `enableBattleTools`
is on **and** the calling thread is its own battle's `orchestratorThreadId`. The member threads keep
the plain `battle` capability and get none of these tools.

- `battle_thread_send { threadId, message }` — refuses a target that is not a member of the caller's
  battle, and refuses the orchestrator itself. Dispatches the server-side `thread.turn.start` with a
  user-role message and records the turn as orchestrator-initiated. Returns immediately, and reports
  whether the target was busy so the agent knows the turn queued.
- `battle_thread_read { threadId, limit }` — returns the recent messages of one member thread, with
  the same membership check. This is the catch-up path; the report-back covers the common case.
- `battle_status` gains `isOrchestrator` on each member row, so a member agent can tell the manager
  apart from its peers.

### 4. Report-back (same reactor)

When a member turn settles, and that turn was started by `battle_thread_send`, dispatch a
`thread.turn.start` into the orchestrator that carries the member's title and its reply.

Loop guards, all four required:

1. Report **only** turns the orchestrator started. A turn the user started in a member thread never
   nudges the orchestrator.
2. Never report the orchestrator's own turns.
3. Coalesce. While the orchestrator is mid-turn, collect the pending reports and deliver them as one
   turn when it settles.
4. A report never starts a turn in a member thread by itself. Only a tool call does that.

### 5. Battle page (`apps/web/src/components/battle/BattlePage.tsx`)

Follow the iterated mock at `C:\Users\cdbak\MarsPortfolio\.lavish\battle-page-plan.html`
(updated 2026-08-23 12:16) for structure and for the hide-away behavior. The mock shows the context
as the top of a scrolling page; the two deltas below supersede it.

**The context does not scroll. It is a fixed overlay.**

- `MessagesTimeline` renders through LegendList, which owns its own scrolling and virtualization.
  There is no shared scroll container to put a header in, so an overlay is both what was asked for
  and the only clean fit.
- Copy the pattern already in `ChatView.tsx:6405` — the provider status banner, which is
  `absolute inset-x-0 top-0 z-20` over the timeline with the comment "overlays the timeline without
  changing its content height." The battle context takes the same position. Unlike that banner it
  is interactive, so the container is `pointer-events-none` and the toggle and thread rows are
  `pointer-events-auto`.
- The overlay needs an opaque background, not a backdrop blur. A blurred layer over a virtualized
  list repaints on every scroll frame and is exactly the kind of GPU cost `AGENTS.md` calls out.
- The transcript needs a matching top inset or its first messages sit under the overlay.
  `MessagesTimeline` already carries `contentInsetEndAdjustment` for the bottom
  (`MessagesTimeline.tsx:229`, applied as `paddingBottom` at line 573). Mirror it with a start
  adjustment rather than inventing a second mechanism.
- The inset must follow the overlay's real height, because the hide-away changes it. Measure with a
  `ResizeObserver` and pass the height through; do not hard-code a height per state.
- `ChatViewProps` therefore gains `overlay?: ReactNode` plus the start inset, **not** the
  `header?: ReactNode` inside a scroll container that an earlier draft of this plan described.

**The overlay text is larger.** From the mock's sizes, one step up on every part:

| Part | Mock | New |
| --- | --- | --- |
| Battle title | 20px | 24px |
| Goal text | 14px | 16px |
| Section labels | 12px | 13px |
| Victory condition rows | 14px | 16px |
| Size scores | 12px | 13px |
| Thread rows | 14px | 15px |

Keep the rest as the mock has it:

- The context is a **centered hero**: title, goal, victory conditions and thread list all center on
  the column.
- It **hides away** behind one centered chevron button below the block. Expanded shows title, goal,
  victory conditions and thread list; collapsed shows title and thread list only. The button swaps
  chevron-up for chevron-down and carries "Hide goal and victory conditions" / "Show goal and
  victory conditions".
- The phase pill and the "N threads" count are **removed** from the hero. The phase stays readable
  from the breadcrumb and the sidebar.
- A click on a thread row opens that member thread.
- Not-found stays: an unresolved battle, and a battle whose orchestrator has not landed yet, both
  render the existing empty state rather than a broken chat.

### 6. Hiding the orchestrator

Filter on `thread.isOrchestrator` in `packages/client-runtime/src/state/battles.ts`, once, so every
caller inherits it. This hides the current orchestrator **and every retired one**, which is what
makes the refresh in section 7 safe.

- `partitionThreadsByBattle` and `buildSidebarBattleRows` drop orchestrator threads, which covers the
  sidebar battle members and the standalone list.
- The battle page thread list excludes them, including the archived ones a refresh leaves behind.
  Without this an old orchestrator would show up in the member list wearing an "Archived" label.
- `CommandPalette` and the inbox (`routes/_chat.index.tsx`) exclude them.
- A direct URL to an orchestrator thread keeps working, and a retired one stays readable from
  Settings → Archived. That is the way back to a conversation a refresh set aside.
- `LegacySidebar` is untouched: it is feature-flagged and has no battle support.
- Pull requests need no change; the orchestrator has no branch, so it cannot appear there.

### 7. Refresh the orchestrator

One button retires the current orchestrator and starts a fresh one, for when a conversation has run
long or gone down a wrong path.

- **Placement.** In the composer's control row, immediately left of the model picker
  (`ChatComposer.tsx:3342`). Put it before the `noProviderAvailable` ternary, not inside its else
  branch, so it stays available when no provider is. The picker's `triggerClassName="-ms-2.5"`
  pulls it leftward and will need review once something sits beside it.
- **Visibility.** Only on a thread with `isOrchestrator`. Every other thread's composer is
  unchanged.
- **What it does.** A `battle.orchestrator.refresh` command that archives the current orchestrator,
  creates a new one the same way section 2 does, and points `orchestratorThreadId` at it. The
  reactor already owns creation; refresh is the same path with an archive in front.
- **Archive, not delete.** The old conversation stays readable in Settings → Archived. Deleting it
  would be an unrecoverable loss of the reasoning behind decisions the battle already acted on.
- **Confirm only when there is something to lose.** An orchestrator with no messages refreshes on
  the click. One with messages asks first, and the dialog says the conversation will be archived,
  not deleted.
- **Report-back.** Pending reports aimed at the retired orchestrator are dropped, not redirected.
  A fresh orchestrator has no context for a reply to a question it never asked.

## Risks

- **Turn gate contention.** The orchestrator runs on the project root, so it shares a `TurnGate`
  permit with local-mode threads on that root. Its turns are short because it does no file work.
  Accepted, not mitigated.
- **Cross-thread injection.** The orchestrator reads member transcripts and can start turns from
  what it reads. A member agent can therefore influence what other members are asked to do. The
  `enableBattleTools` setting gates the whole surface, and the membership check keeps the blast
  radius inside one battle.
- **Report-back storms.** Guard 3 is what keeps a five-thread battle from starting five orchestrator
  turns at once.

## Non-goals

- No mobile surface. Mobile has no battle support today.
- No orchestrator for a thread that is in no battle.
- No blocking `battle_thread_ask`. The reply model is async.
- No per-thread tool restrictions. "Manager only" comes from having no worktree, not from a
  permission system that does not exist yet.

## Proposed victory conditions

Add these to the battle. Sizes are provisional until each is planned.

| Condition                                                                                             | Size |
| ----------------------------------------------------------------------------------------------------- | ---- |
| Every battle has exactly one orchestrator thread, created automatically and backfilled for existing battles | ~3   |
| The orchestrator can send a message to any member thread of its own battle, and to no other thread    | ~3   |
| The orchestrator receives a member's reply automatically when the turn it started finishes            | ~4   |
| The orchestrator can read a member thread's recent messages on demand                                 | ~2   |
| The orchestrator thread is hidden from the sidebar, the inbox, and the command palette                | ~2   |
| The battle page hosts the orchestrator chat under a fixed, centered battle context overlay that hides away to title plus threads | ~4   |
| One button refreshes the orchestrator: the old thread is archived and a fresh one takes its place | ~3   |
| Repo checks pass: typecheck, lint, and affected tests                                                 | ~1   |

## Verify

1. Server tests for the new reactor: creation on `battle.created`, startup backfill, report-back
   fires once per orchestrator-initiated turn, and coalescing while the orchestrator is busy. Wait on
   receipts, never on sleeps.
2. MCP handler tests: a member thread is refused the orchestrator tools; the orchestrator is refused
   a target outside its battle; a send to a busy target queues instead of failing.
3. Decider tests: `battle.orchestrator.set` refuses a thread outside the battle and a thread that
   is not flagged `isOrchestrator`; a refresh leaves exactly one current orchestrator.
4. Client test: a retired orchestrator stays out of the sidebar, the battle page thread list, the
   inbox and the command palette after a refresh archives it.
5. `pnpm --filter @t3tools/web typecheck`, targeted lint, and the web tests that cover the sidebar and
   battle logic.
6. One manual pass in a real client over the combined page — the battle context, the hide-away, the
   orchestrator chat and the member navigation in the same view. This is also the pass the
   battle-page work still owed; it is no longer a separate check.
