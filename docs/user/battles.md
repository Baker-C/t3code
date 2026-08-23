# Battles

A battle groups several threads under one goal. Instead of holding the shape of a large piece of
work in your head across a handful of unrelated threads, you write the goal down once, break it
into victory conditions, and let each thread fight for part of it.

Battles are optional. A thread that belongs to no battle behaves exactly as it always has.

## Starting a battle

Battles are chosen while a thread is still a draft, from the **Battle** control in the toolbar
above the composer — the same row where you pick a branch or worktree. Pick an existing battle to
enlist the new thread in it, or choose **New battle…** and give it a name and, optionally, a goal.

The choice is locked in when you send the thread's first message. After that the toolbar shows
which battle the thread fights in but no longer offers to change it, so start a new thread if you
want another one in the fight.

## Victory conditions

A victory condition is a unit of **scope**, not of completion. It is met the moment its plan is
pinned down — before any code lands. This is the part most worth internalizing: you are not
ticking off finished work, you are recording that you now know what the work is.

Each condition sits in one of four states:

| State        | Meaning                                                   |
| ------------ | --------------------------------------------------------- |
| **Unscoped** | Named, but nobody has worked out what it involves.        |
| **Scoping**  | Someone is figuring it out right now.                     |
| **Scoped**   | The plan is pinned down. This condition is met.           |
| **Descoped** | Struck from the battle, with a reason kept on the record. |

Conditions carry an optional size score from 0 to 5. A score written before scoping finished is an
estimate, and appears with a leading tilde (`~3`) so a guess never reads as a settled number.

Striking a condition does not delete it. It moves to **Descoped** and keeps the reason you gave, so
the battle remembers what you decided not to do and why.

Open a battle's conditions from the composer, where a battle tab sits beside the message box for
every thread in a battle. Add a condition by typing its title; change a state or size from the
condition's own menu.

## Phases

A battle is scoping, fighting, or defeated, and the label beside its name tells you which:

- **Drawing battle lines** — scoping, with conditions still unresolved.
- **Battle lines drawn** — still scoping, but every condition is now resolved (scoped or descoped)
  and at least one survived. The battle is fully planned and ready to move to fighting.
- **Fighting** — the plans are settled and the work is underway.
- **Defeated** — the battle is over.

"Battle lines drawn" is derived, not chosen: T3 Code works it out from the conditions themselves,
and a battle can only start fighting once it reads that way. A battle with nothing but struck
conditions never qualifies, because nothing survived to fight for.

## The battle page

Click a battle in the sidebar to open its page in the main window. The page shows the battle's
title and phase, its goal, its victory conditions with their states and scope progress, and every
thread enlisted in the battle — click a thread to jump to it. When a battle spans several
worktrees, its threads group under a label per worktree, the same way the sidebar shows them. The
page follows along live as conditions change and threads come and go.

## Threads in a battle

A thread joins a battle when it is created, and stays in it. There is no moving a thread between
battles afterwards — mid-conversation reassignment is the part of this model that goes wrong, so
T3 Code does not offer it.

In the sidebar, a battle's threads group under the battle's name inside their project, with the
scope progress beside it. The chevron beside a battle collapses its threads to tuck them away; a
collapsed battle still shows a status dot while any of its threads is working or waiting on you.

A battle owns no branch and no worktree of its own. Its threads keep their own, which is what lets
one battle span several repositories — a frontend checkout and a backend checkout can both be part
of the same fight. Threads that need to work side by side in one checkout can also share a
worktree; see the section below.

## Declaring defeat, and reopening

When the work is done, open the battle's menu and choose **Declare defeat**. The confirmation lists
the branches the battle's threads are sitting on, so you can see what is about to be left behind,
and offers to **remove the worktrees** once you are finished with them.

T3 Code does not merge your branches for you. Defeat is a record that the fight is over; landing
the code is still yours to do, per repository. Removing worktrees is offered as cleanup, and only
touches worktrees used solely by this battle's threads — a worktree another thread still shares is
left alone. A worktree with uncommitted changes is also left alone rather than discarded.

A defeated battle moves to the **Defeated** shelf at the bottom of the sidebar, with its threads
still inside it. Choose **Reopen battle** from the shelf or the battle menu to bring it back to
Fighting; nothing is re-created eagerly, and a thread whose worktree was removed gets a fresh one
from its branch the next time you send it a message.

## Letting agents update conditions

Under **Settings → Integrations → Battles**, the battle tools switch lets the agents working in a
battle read its status and update its victory conditions themselves — an agent that finishes
scoping can mark its own condition scoped, or add one it discovered along the way. Every change an
agent makes is attributed to its thread, exactly like an edit you make by hand.

The switch is off by default. When it is off, both the tools and the instructions describing them
are withheld from agent sessions, and you edit conditions yourself. Turning it on applies to
sessions started from then on; an agent already running keeps the tools it was given.

## Threads that share a worktree take turns

**This applies whether or not you use battles.** When two or more threads resolve to the same
worktree — or to the same project checkout, when they run without a worktree — their turns now run
one at a time instead of at once. A thread waiting its turn shows a line under the composer naming
the thread it is waiting on, and starts as soon as the other finishes.

Previously those turns ran concurrently, which meant two agents editing one checkout could
overwrite each other's work mid-turn. Taking turns is the fix. Threads in _different_ worktrees are
unaffected and still run in parallel, including threads in the same battle — a battle spanning a
frontend and a backend checkout fights on both fronts at once.

One consequence worth knowing: for threads sharing a checkout, a turn's diff is measured from the
moment that turn started rather than from the previous turn, so a sibling's interleaved work does
not show up in yours. Restoring an earlier checkpoint is refused when another thread sharing the
checkout has done work since the point you are restoring to, rather than silently discarding it.
