# Kickoff prompt — orchestrator thread scope

Paste the block below as the first message of a **new T3 thread enlisted in the battle
"Battle upgrades: battle page"**. Pick the battle from the **Battle** control in the composer
toolbar while the thread is still a draft — that is what gives the thread its `battleId`, and the
`battle_*` MCP tools are minted from it.

---

Read `.plans/battle-orchestrator-thread.md` first. It is the scope for the work in this message, and
it records the four decisions already made, the codebase audit behind them, and the loop guards the
report-back reactor needs. Also open the mock at
`C:\Users\cdbak\MarsPortfolio\.lavish\battle-page-plan.html` in a browser or read its markup — it is
the authority for how the battle context looks and how it hides away.

## Step 1 — put the scope on the battle record

Call `battle_status` first to see what the battle already carries, then add these seven victory
conditions with `battle_condition_add`. Add them `unscoped` with `sizeProvisional: true`, because
these sizes come from a codebase audit and not from a finished plan of each condition:

| Title | sizeScore |
| --- | --- |
| Every battle has exactly one orchestrator thread, created automatically and backfilled for existing battles | 3 |
| The orchestrator can send a message to any member thread of its own battle, and to no other thread | 3 |
| The orchestrator receives a member's reply automatically when the turn it started finishes | 4 |
| The orchestrator can read a member thread's recent messages on demand | 2 |
| The orchestrator thread is hidden from the sidebar, the inbox, and the command palette | 2 |
| The battle page hosts the orchestrator chat under a centered battle context that hides away to title plus threads | 3 |
| Repo checks pass: typecheck, lint, and affected tests | 1 |

Do not re-add a condition the battle already has. The six conditions from the battle-page work are
already on the record and are already scoped; leave them alone.

Then, as you plan each new condition, move it to `scoping` while you work it out and to `scoped`
the moment its plan is pinned — before any code lands. Set `sizeProvisional: false` when the size
comes from the finished plan. That is what these tools are for; use them as you go rather than in
one pass at the end.

## Step 2 — build it

**Start from the uncommitted battle-page work already in the tree, and ship it together with yours.**
The battle page and the orchestrator are one feature, not two: the battle page *is* the orchestrator
thread's page. Everything goes out in one shipment.

What is already in the working tree, unstaged, from `.plans/battle-detail-page.md`:

- `apps/web/src/routes/_chat.battles.$environmentId.$battleId.tsx` — the route. Keep it.
- `apps/web/src/components/battle/BattlePage.tsx` — the page. Build on it; do not rewrite it from
  scratch. Its data wiring (`useBattle`, `useThreadShellsForProjectRefs`, `battleScopeProgress`),
  its condition rendering and its thread rows all survive. What changes is the layout: centered
  hero, the hide-away toggle, the phase pill and thread count removed, and `ChatView` below it.
- `apps/web/src/components/Sidebar.tsx` — battle row navigates, chevron still collapses. Keep.
- `apps/web/src/routeTree.gen.ts`, `docs/user/battles.md`, `BattleConditionsBadge.tsx` — keep.

Treat that work as your baseline and extend it. Do not revert it, and do not open a second page.

Then work through `.plans/battle-orchestrator-thread.md` in its order. The six sections are written
to be taken one at a time:

1. Contracts: `orchestratorThreadId` on `OrchestrationBattle`, the `battle.orchestrator.set` command
   and the `battle.orchestrator-set` event.
2. `BattleOrchestratorReactor`: creation on `battle.created`, plus the startup backfill that gives
   this battle its own orchestrator.
3. The `battle-orchestrator` capability and the `battle_thread_send` / `battle_thread_read` tools.
4. Report-back, with all four loop guards. This is the part most likely to go wrong; write its tests
   first.
5. The battle page: `ChatView` header slot, centered hero, the hide-away toggle.
6. Hiding the orchestrator from every thread list, derived once in `client-runtime/state/battles.ts`.

Things the plan already settled, so do not re-litigate them:

- The orchestrator has no branch and no worktree. It runs on the project root.
- `thread.turn.start` has no busy-target guard, and `TurnGate` serializes per cwd. A send to a busy
  member queues; it does not fail. Do not build a second queue.
- Hiding needs no new field on the thread. The shell already streams every battle.

## Constraints

- `AGENTS.md` governs. Read it before you start, in particular the three ways to hurt yourself.
- Server behavior changes ship with focused tests. Wait on receipts and worker drains, never on
  sleeps or polling.
- Do not run repo-wide checks. Targeted typecheck, targeted lint, and the tests you touched.
- Do not open a PR. Do not start or kill dev servers without asking.
- The manual pass the battle-page work still owes is now one pass over the combined page: open a
  battle, confirm the context, the hide-away, the orchestrator chat and the member navigation all
  work in the same view. Ask before doing it — it needs a dev server or a rebuilt desktop app.

Report back with what you scoped, what you built, and what you left.
