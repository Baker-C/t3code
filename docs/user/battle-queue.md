# Battle queue

The battle queue is a focus list: the battles you want to be cycling through _right now_, drawn
from any project, in the order you want to meet them.

The loop it is built for is simple. Dig into one battle, give it direction, hand off, hit next,
land on the following one. Keep going until things resolve.

**It is not a backlog.** The battles themselves are the durable record of what you are working on.
The queue is only what you are thinking about at this moment. Anything stale in it is yours to
remove, and nothing tidies it for you.

## Adding a battle

Add a battle from its own page, with **Add to queue** — you are already there when you decide it
matters. You set its priority as you add it.

A battle you have just added shows as **not started**. It is in the list and prioritised, but has
no work attached yet. That is the point: the slot is the intent, and the work follows.

## Actions

Underneath each battle sit its **actions**. An action is one unit of kicked-off work: the threads
you set going together, plus the rule for when they should want you back.

An action is created when you **start work**, never by a thread merely existing. A battle with five
idle threads you have not touched has no actions at all.

### Grouping threads

Threads are grouped into the units you hand off as one piece. Every thread starts in a group of its
own; drag one onto another in the battle view to group them. When any thread in a group starts a
turn, one action forms around that whole group rather than one action per thread.

The battle's orchestrator can group threads too, if you ask it to. Both routes write the same
grouping, so the battle view always shows the current one.

### When an action wants you back

By default an action becomes available when **every thread in it is idle and waiting on you**.

You can relax that per action, either yourself or by asking the orchestrator:

| Wake on            | Meaning                                                   |
| ------------------ | --------------------------------------------------------- |
| **All** (default)  | Every thread in the action is back.                       |
| **Any**            | The first thread back is enough.                          |
| **A named thread** | One particular thread is back; the rest can keep running. |

A thread that has finished and will not be used again is simply a thread waiting on you, so it
never holds its group up. There is no separate "done" state to manage.

A thread waiting its turn on a shared worktree just counts as busy. Its action waits longer, which
is expected rather than a problem, and nothing special is shown for it.

## What a row tells you

Each row is a **battle**, at its position in the order. A battle appears once no matter how many
actions it has, which is what keeps the list short enough to move through quickly.

A row shows whether it is **ready** — at least one action wants you — **working**, or **not
started**. A battle can be ready and working at the same time: one action wants you while another
is still running. The row reads as ready, and you sort out which is which inside the battle.

Ready actions come in three flavours. All of them want you; they want different things:

| Outcome                 | Meaning                                                  |
| ----------------------- | -------------------------------------------------------- |
| **Completed**           | The step is done and ready for its next instruction.     |
| **Needs clarification** | It knows what it is doing and needs a decision from you. |
| **Errored**             | It cannot proceed.                                       |

**An errored action is marked on its row but does not jump the queue.** You set your priorities
deliberately, and a failure should not override your judgement about what matters. The mark is
there so a failed turn cannot go quiet and drop off your radar.

Work that is still in flight is not hidden away: a battle with nothing settled yet reads as
**working** and sits in the list like any other row, so you always know something is running even
when nothing wants you.

The queue shows one battle at a time — the one the cycle would hand you next — and tucks the rest
behind **Show more**. When nothing is ready there is no next battle to feature, so the top of the
list falls back to the first three rows in order instead of emptying out.

## Order

Priority lives on both **projects** and **battles**, because personal projects naturally sit below
work ones while individual battles vary within each. Both run 0–3, where **0 means unset rather
than lowest**.

The two are **combined**, not ranked one above the other. That matters: if project priority simply
won, a low-priority chore in a work project would always outrank an urgent personal fire. Combining
them lets a top-priority personal battle genuinely beat a low-priority work one.

You will never see a score. The list shows you the order; that is the whole point of it. If the
order feels wrong, set a priority — that is a two-second fix, and it is how you pull a whole
project up or down.

## Cycling

The battle at the top of the queue **is** the next one: it is the highest-priority battle that has
something ready and is not the one you are already in, so clicking it is the whole cycle. Land in
it, and the slot refills with the one after. There is no separate Next button, because a button and
a row that always agree are the same control twice.

Cycling moves between battles, never between actions — once you are inside a battle, all of its
actions are there for you to pick from.

### Skipping

**Skip** passes over the current battle for the rest of the lap. Without it, skipping something
would bounce you straight back to it as soon as you finished the next battle, because it is still
ready and still high priority.

A lap ends once every battle that could be offered has been offered. Then everything is fair game
again.

If something in a battle you skipped becomes ready again, its skip clears and it rejoins the lap.
New work is new information, so it earns its place back. Skip it again and it drops out again.

**Skip is greyed out when it would not take you anywhere** — when nothing else is ready to move on
to, when the battle you are in has nothing ready, or when you have already passed it over this lap.
Hover it to see which.

## Removing battles

Battles leave the queue in three ways:

- **You remove them.** **Remove** appears on a row when you hover or focus it, and **Clear queue**
  in the queue's own menu wipes the lot for a fresh sit-down.
- **You declare the battle defeated.** It drops out on its own.
- **You delete the battle.** It goes with it.

Reopening a defeated battle does **not** put it back in the queue. Requeueing is deliberate.

Nothing is removed for being stale. Keeping the queue honest is your discipline, not the app's.

## Several machines at once

A queue belongs to the environment that owns the battles in it, so a queue never spans machines.
If your client is connected to more than one environment, you see all of their queues merged into
one list, ordered by priority and **labelled with the environment each row belongs to**.

Rows interleave rather than grouping by machine: priority is the point of the list, and it should
not defer to which machine happens to own the work. Connections do not have to match — a work
laptop might connect only itself while your home machine connects both. There is nothing to sync.

## Settings

Under **Settings → Integrations → Battles**:

| Setting                  | What it does                                             |
| ------------------------ | -------------------------------------------------------- |
| **Battle queue**         | Shows or hides the queue entirely.                       |
| **Project priority**     | Whether a project's priority counts toward the order.    |
| **Battle priority**      | Whether a battle's own priority counts toward the order. |
| **Round-robin skipping** | Whether the skip control is available at all.            |

Turning both priority switches off runs the queue flat, with no tiers.

**Turning the queue off does not empty it.** Your working set is kept, so turning it back on
returns the list you had.
