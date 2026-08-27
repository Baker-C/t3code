import {
  BattleId,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationShellSnapshot,
  type OrchestrationThread,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";

import { PrimaryConnectionTarget } from "../connection/model.ts";
import {
  InvalidScopedProjectKeyError,
  InvalidScopedProjectRefCollectionKeyError,
  InvalidScopedThreadKeyError,
  parseProjectKey,
  parseProjectRefCollectionKey,
  parseThreadKey,
} from "./entities.ts";
import type { EnvironmentShellState } from "./shell.ts";
import { EMPTY_ENVIRONMENT_THREAD_STATE, type EnvironmentThreadState } from "./threads.ts";
import { createEnvironmentProjectAtoms } from "./projectEntities.ts";
import { createEnvironmentSnapshotAtom } from "./snapshots.ts";
import { createEnvironmentThreadDetailAtoms } from "./threadDetail.ts";
import { mergeEnvironmentThread } from "./threadDetail.ts";
import { createEnvironmentThreadShellAtoms } from "./threadShell.ts";

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");
const PROJECT_ID = ProjectId.make("project-1");
const OTHER_PROJECT_ID = ProjectId.make("project-2");
const THREAD_ID = ThreadId.make("thread-1");
const OTHER_THREAD_ID = ThreadId.make("thread-2");

describe("scoped entity keys", () => {
  it("preserves an invalid project key as structured error data", () => {
    const key = "missing-project-key-separator";
    let error: unknown;

    try {
      parseProjectKey(key);
    } catch (cause) {
      error = cause;
    }

    expect(error).toEqual(new InvalidScopedProjectKeyError({ key }));
  });

  it("preserves an invalid thread key as structured error data", () => {
    const key = "missing-thread-key-separator";
    let error: unknown;

    try {
      parseThreadKey(key);
    } catch (cause) {
      error = cause;
    }

    expect(error).toEqual(new InvalidScopedThreadKeyError({ key }));
  });

  it("preserves malformed project reference collection input and its cause", () => {
    const key = "not-json";
    let error: unknown;

    try {
      parseProjectRefCollectionKey(key);
    } catch (cause) {
      error = cause;
    }

    expect(error).toBeInstanceOf(InvalidScopedProjectRefCollectionKeyError);
    expect(error).toMatchObject({ key, cause: expect.anything() });
  });

  it("rejects invalid project reference collection shapes", () => {
    const key = JSON.stringify([["environment-1"]]);

    expect(() => parseProjectRefCollectionKey(key)).toThrowError(
      InvalidScopedProjectRefCollectionKeyError,
    );
  });
});

const THREAD_SHELL = {
  id: THREAD_ID,
  projectId: PROJECT_ID,
  title: "Thread",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt: "2026-06-01T00:00:00.000Z",
  updatedAt: "2026-06-01T00:00:00.000Z",
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  session: null,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
} as const;

const SNAPSHOT: OrchestrationShellSnapshot = {
  snapshotSequence: 1,
  updatedAt: "2026-06-01T00:00:00.000Z",
  battles: [],
  projects: [
    {
      id: PROJECT_ID,
      title: "Project",
      workspaceRoot: "/repo",
      repositoryIdentity: null,
      defaultModelSelection: null,
      scripts: [],
      createdAt: "2026-06-01T00:00:00.000Z",
      updatedAt: "2026-06-01T00:00:00.000Z",
    },
    {
      id: OTHER_PROJECT_ID,
      title: "Other project",
      workspaceRoot: "/other-repo",
      repositoryIdentity: null,
      defaultModelSelection: null,
      scripts: [],
      createdAt: "2026-06-01T00:00:00.000Z",
      updatedAt: "2026-06-01T00:00:00.000Z",
    },
  ],
  threads: [
    THREAD_SHELL,
    {
      ...THREAD_SHELL,
      id: OTHER_THREAD_ID,
      projectId: OTHER_PROJECT_ID,
      title: "Other thread",
    },
  ],
};

/** The same snapshot with THREAD_ID enlisted as a battle's orchestrator. */
const SNAPSHOT_WITH_ORCHESTRATOR: OrchestrationShellSnapshot = {
  ...SNAPSHOT,
  snapshotSequence: 2,
  battles: [
    {
      id: BattleId.make("battle-1"),
      projectId: PROJECT_ID,
      title: "Battle",
      goal: null,
      slug: "battle",
      phase: "scoping",
      victoryConditions: [],
      orchestratorThreadId: THREAD_ID,
      defeatedAt: null,
      createdAt: "2026-06-01T00:00:00.000Z",
      updatedAt: "2026-06-01T00:00:00.000Z",
      deletedAt: null,
    },
  ],
};

/**
 * A refresh has landed: the battle now names a different manager, and THREAD_ID
 * is the retired one — still flagged, no longer bound.
 */
const SNAPSHOT_AFTER_ORCHESTRATOR_REFRESH: OrchestrationShellSnapshot = {
  ...SNAPSHOT_WITH_ORCHESTRATOR,
  snapshotSequence: 3,
  threads: [
    { ...THREAD_SHELL, isOrchestrator: true, archivedAt: "2026-06-02T00:00:00.000Z" },
    {
      ...THREAD_SHELL,
      id: OTHER_THREAD_ID,
      projectId: OTHER_PROJECT_ID,
      title: "Other thread",
    },
  ],
  battles: [
    {
      ...SNAPSHOT_WITH_ORCHESTRATOR.battles[0]!,
      orchestratorThreadId: ThreadId.make("thread-replacement"),
    },
  ],
};

function shellState(snapshot: OrchestrationShellSnapshot): EnvironmentShellState {
  return {
    snapshot: Option.some(snapshot),
    status: "live",
    error: Option.none(),
  };
}

function makeHarness() {
  const shellStateAtoms = Atom.family((_environmentId: EnvironmentId) =>
    Atom.make(AsyncResult.success(shellState(SNAPSHOT))),
  );
  const threadStateAtoms = Atom.family((_key: string) =>
    Atom.make(AsyncResult.success(EMPTY_ENVIRONMENT_THREAD_STATE)),
  );
  const catalogValueAtom = Atom.make({
    isReady: true,
    entries: new Map([
      [
        ENVIRONMENT_ID,
        {
          target: new PrimaryConnectionTarget({
            environmentId: ENVIRONMENT_ID,
            label: "Environment",
            httpBaseUrl: "https://example.test",
            wsBaseUrl: "wss://example.test",
          }),
          profile: Option.none(),
        },
      ],
    ]),
  });
  const snapshotAtom = createEnvironmentSnapshotAtom(shellStateAtoms);
  const projects = createEnvironmentProjectAtoms({
    catalogValueAtom,
    snapshotAtom,
  });
  const threadShells = createEnvironmentThreadShellAtoms({
    catalogValueAtom,
    snapshotAtom,
  });
  const threadDetails = createEnvironmentThreadDetailAtoms((environmentId, threadId) =>
    threadStateAtoms(`${environmentId}\u0000${threadId}`),
  );

  return {
    registry: AtomRegistry.make(),
    shellStateAtom: shellStateAtoms(ENVIRONMENT_ID),
    threadStateAtom: (threadId: ThreadId) => threadStateAtoms(`${ENVIRONMENT_ID}\u0000${threadId}`),
    projects,
    threadShells,
    threadDetails,
  };
}

describe("environment entity projections", () => {
  it("composes detail collections with authoritative shell workspace metadata", () => {
    const messages: OrchestrationThread["messages"] = [];
    const detail = {
      ...THREAD_SHELL,
      environmentId: ENVIRONMENT_ID,
      title: "Cached thread",
      branch: "stale-branch",
      worktreePath: "/repo/stale-worktree",
      deletedAt: null,
      messages,
      proposedPlans: [],
      activities: [],
      checkpoints: [],
    } satisfies OrchestrationThread & { readonly environmentId: EnvironmentId };
    const shell = {
      ...THREAD_SHELL,
      environmentId: ENVIRONMENT_ID,
      title: "Current thread",
      branch: "current-branch",
      worktreePath: "/repo/current-worktree",
    };

    const merged = mergeEnvironmentThread(detail, shell);

    expect(merged).toMatchObject({
      title: "Current thread",
      branch: "current-branch",
      worktreePath: "/repo/current-worktree",
    });
    expect(merged?.messages).toBe(messages);
  });

  it("preserves untouched project and thread identities across unrelated shell updates", () => {
    const harness = makeHarness();
    const projectRefsAtom = harness.projects.environmentProjectRefsAtom(ENVIRONMENT_ID);
    const threadRefsAtom = harness.threadShells.environmentThreadRefsAtom(ENVIRONMENT_ID);
    const projectsAtom = harness.projects.projectsAtom;
    const projectAtom = harness.projects.projectAtom({
      environmentId: ENVIRONMENT_ID,
      projectId: PROJECT_ID,
    });
    const threadAtom = harness.threadShells.threadShellAtom({
      environmentId: ENVIRONMENT_ID,
      threadId: THREAD_ID,
    });
    const projectRefs = harness.registry.get(projectRefsAtom);
    const threadRefs = harness.registry.get(threadRefsAtom);
    const projects = harness.registry.get(projectsAtom);
    const project = harness.registry.get(projectAtom);
    const thread = harness.registry.get(threadAtom);

    harness.registry.set(
      harness.shellStateAtom,
      AsyncResult.success(
        shellState({
          ...SNAPSHOT,
          snapshotSequence: 2,
          threads: SNAPSHOT.threads.map((candidate) =>
            candidate.id === OTHER_THREAD_ID
              ? { ...candidate, title: "Renamed other thread" }
              : candidate,
          ),
        }),
      ),
    );

    expect(harness.registry.get(projectRefsAtom)).toBe(projectRefs);
    expect(harness.registry.get(threadRefsAtom)).toBe(threadRefs);
    expect(harness.registry.get(projectsAtom)).toBe(projects);
    expect(harness.registry.get(projectAtom)).toBe(project);
    expect(harness.registry.get(threadAtom)).toBe(thread);
  });

  it("preserves project-scoped thread collections across unrelated project updates", () => {
    const harness = makeHarness();
    const projectRef = {
      environmentId: ENVIRONMENT_ID,
      projectId: PROJECT_ID,
    };
    const refsByProjectAtom =
      harness.threadShells.environmentThreadRefsByProjectAtom(ENVIRONMENT_ID);
    const threadsAtom = harness.threadShells.threadShellsForProjectRefsAtom([projectRef]);
    const refs = harness.registry.get(refsByProjectAtom).get(PROJECT_ID);
    const threads = harness.registry.get(threadsAtom);

    expect(threads).toHaveLength(1);
    expect(threads[0]?.id).toBe(THREAD_ID);

    harness.registry.set(
      harness.shellStateAtom,
      AsyncResult.success(
        shellState({
          ...SNAPSHOT,
          snapshotSequence: 2,
          threads: SNAPSHOT.threads.map((thread) =>
            thread.id === OTHER_THREAD_ID ? { ...thread, title: "Updated elsewhere" } : thread,
          ),
        }),
      ),
    );

    expect(harness.registry.get(refsByProjectAtom).get(PROJECT_ID)).toBe(refs);
    expect(harness.registry.get(threadsAtom)).toBe(threads);
  });

  it("updates only the requested thread detail and preserves untouched field identities", () => {
    const harness = makeHarness();
    const threadRef = {
      environmentId: ENVIRONMENT_ID,
      threadId: THREAD_ID,
    };
    const otherThreadRef = {
      environmentId: ENVIRONMENT_ID,
      threadId: OTHER_THREAD_ID,
    };
    const threadDetailAtom = harness.threadDetails.detailAtom(threadRef);
    const messagesAtom = harness.threadDetails.messagesAtom(threadRef);
    const activitiesAtom = harness.threadDetails.activitiesAtom(threadRef);
    const statusAtom = harness.threadDetails.statusAtom(threadRef);
    const otherThreadDetailAtom = harness.threadDetails.detailAtom(otherThreadRef);
    const otherValue = harness.registry.get(otherThreadDetailAtom);
    const detail = {
      ...THREAD_SHELL,
      deletedAt: null,
      messages: [],
      proposedPlans: [],
      activities: [],
      checkpoints: [],
    } satisfies OrchestrationThread;

    harness.registry.set(
      harness.threadStateAtom(THREAD_ID),
      AsyncResult.success<EnvironmentThreadState>({
        data: Option.some(detail),
        status: "live",
        error: Option.none(),
        page: Option.none(),
      }),
    );

    const scopedDetail = harness.registry.get(threadDetailAtom);
    const messages = harness.registry.get(messagesAtom);
    const activities = harness.registry.get(activitiesAtom);

    expect(scopedDetail).toEqual({ ...detail, environmentId: ENVIRONMENT_ID });
    expect(harness.registry.get(statusAtom)).toBe("live");
    expect(harness.registry.get(otherThreadDetailAtom)).toBe(otherValue);

    harness.registry.set(
      harness.threadStateAtom(THREAD_ID),
      AsyncResult.success<EnvironmentThreadState>({
        data: Option.some({
          ...detail,
          session: {
            threadId: THREAD_ID,
            status: "ready",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: "2026-06-01T00:01:00.000Z",
          },
        }),
        status: "live",
        error: Option.none(),
        page: Option.none(),
      }),
    );

    expect(harness.registry.get(messagesAtom)).toBe(messages);
    expect(harness.registry.get(activitiesAtom)).toBe(activities);
  });
});

describe("orchestrator threads", () => {
  it("drops a battle's orchestrator from the shell lists but still resolves it by ref", () => {
    const harness = makeHarness();
    const projectRef = { environmentId: ENVIRONMENT_ID, projectId: PROJECT_ID };
    const threadRef = { environmentId: ENVIRONMENT_ID, threadId: THREAD_ID };
    const projectThreadsAtom = harness.threadShells.threadShellsForProjectRefsAtom([projectRef]);

    expect(harness.registry.get(harness.threadShells.threadShellsAtom).map((t) => t.id)).toEqual([
      THREAD_ID,
      OTHER_THREAD_ID,
    ]);
    expect(harness.registry.get(projectThreadsAtom).map((thread) => thread.id)).toEqual([
      THREAD_ID,
    ]);

    harness.registry.set(
      harness.shellStateAtom,
      AsyncResult.success(shellState(SNAPSHOT_WITH_ORCHESTRATOR)),
    );

    expect(harness.registry.get(harness.threadShells.threadShellsAtom).map((t) => t.id)).toEqual([
      OTHER_THREAD_ID,
    ]);
    expect(harness.registry.get(projectThreadsAtom)).toEqual([]);
    // The direct URL is the escape hatch: resolving by ref is untouched.
    expect(harness.registry.get(harness.threadShells.threadShellAtom(threadRef))?.id).toBe(
      THREAD_ID,
    );
  });
  it("keeps a retired orchestrator out of the shell lists after a refresh rebinds", () => {
    const harness = makeHarness();
    const projectRef = { environmentId: ENVIRONMENT_ID, projectId: PROJECT_ID };
    const projectThreadsAtom = harness.threadShells.threadShellsForProjectRefsAtom([projectRef]);

    harness.registry.set(
      harness.shellStateAtom,
      AsyncResult.success(shellState(SNAPSHOT_AFTER_ORCHESTRATOR_REFRESH)),
    );

    // The battle no longer names THREAD_ID, so only its own flag can keep it
    // out. This is the list the inbox and the command palette read.
    expect(harness.registry.get(harness.threadShells.threadShellsAtom).map((t) => t.id)).toEqual([
      OTHER_THREAD_ID,
    ]);
    expect(harness.registry.get(projectThreadsAtom)).toEqual([]);
    expect(
      harness.registry.get(
        harness.threadShells.threadShellAtom({
          environmentId: ENVIRONMENT_ID,
          threadId: THREAD_ID,
        }),
      )?.id,
    ).toBe(THREAD_ID);
  });
});
