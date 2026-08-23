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
| Page layout         | Title, phase and goal stay pinned. Conditions and the thread list collapse to a summary line as the transcript scrolls.                          |
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
- The client shell already streams every battle (`OrchestrationShellSnapshot.battles`), so the
  clients can identify orchestrator threads without a new thread field.
- `ChatView` (`apps/web/src/components/ChatView.tsx`, 6832 lines) takes `routeKind: "server" |
"draft"` and has no header slot.

## Changes

### 1. Contracts (`packages/contracts/src/orchestration.ts`)

- `OrchestrationBattle` gets `orchestratorThreadId: Schema.optional(Schema.NullOr(ThreadId))`.
  Optional, so snapshots written before this change still decode.
- New command `battle.orchestrator.set { commandId, battleId, threadId }` and new event
  `battle.orchestrator-set`. The decider refuses the command when the battle already has an
  orchestrator, so one battle can never hold two.
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
(updated 2026-08-23 12:16). It supersedes the earlier layout in this plan.

- `ChatViewProps` gains an optional `header?: ReactNode` rendered above the transcript, inside the
  existing scroll container. This is the smallest change that keeps one composer implementation.
- The battle context is a **centered hero** above the transcript, not a left-aligned page header:
  the title, the goal text, the victory conditions and the thread list all center on the column.
- The context **hides away** behind one centered chevron button below the block:
  - Expanded: title, goal, victory conditions, thread list.
  - Collapsed: title and thread list only. The goal text and the whole victory-conditions section
    are hidden.
  - The button swaps a chevron-up for a chevron-down and carries the label "Hide goal and victory
    conditions" / "Show goal and victory conditions".
- The phase pill and the "N threads" count are **removed** from the hero. The phase stays readable
  from the breadcrumb and the sidebar.
- The thread list keeps its current behavior: a click opens that member thread.
- Not-found stays: an unresolved battle, and a battle whose orchestrator has not landed yet, both
  render the existing empty state rather than a broken chat.

### 6. Hiding the orchestrator

Derive the orchestrator ids once in `packages/client-runtime/src/state/battles.ts` from the battles
already in the shell, and filter there so every caller inherits it:

- `partitionThreadsByBattle` and `buildSidebarBattleRows` drop orchestrator threads, which covers the
  sidebar battle members and the standalone list.
- The battle page thread count and thread list exclude it.
- `CommandPalette` and the inbox (`routes/_chat.index.tsx`) exclude it.
- A direct URL to the orchestrator thread keeps working. That is the escape hatch, not a surface.
- `LegacySidebar` is untouched: it is feature-flagged and has no battle support.
- Pull requests need no change; the orchestrator has no branch, so it cannot appear there.

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
| The battle page hosts the orchestrator chat under a centered battle context that hides away to title plus threads | ~3   |
| Repo checks pass: typecheck, lint, and affected tests                                                 | ~1   |

## Verify

1. Server tests for the new reactor: creation on `battle.created`, startup backfill, report-back
   fires once per orchestrator-initiated turn, and coalescing while the orchestrator is busy. Wait on
   receipts, never on sleeps.
2. MCP handler tests: a member thread is refused the orchestrator tools; the orchestrator is refused
   a target outside its battle; a send to a busy target queues instead of failing.
3. Decider test: a second `battle.orchestrator.set` on one battle is refused.
4. `pnpm --filter @t3tools/web typecheck`, targeted lint, and the web tests that cover the sidebar and
   battle logic.
5. One manual pass in a real client over the combined page — the battle context, the hide-away, the
   orchestrator chat and the member navigation in the same view. This is also the pass the
   battle-page work still owed; it is no longer a separate check.
