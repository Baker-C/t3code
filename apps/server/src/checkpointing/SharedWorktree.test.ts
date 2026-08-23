import { ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  findWorktreeSiblingThreadIds,
  worktreeIsShared,
  type SharedWorktreeProject,
  type SharedWorktreeThread,
} from "./SharedWorktree.ts";

const projectId = ProjectId.make("project-1");
const otherProjectId = ProjectId.make("project-2");

const projects: ReadonlyArray<SharedWorktreeProject> = [
  { id: projectId, workspaceRoot: "/repo/main" },
  { id: otherProjectId, workspaceRoot: "/repo/other" },
];

function thread(
  id: string,
  worktreePath: string | null,
  project = projectId,
): SharedWorktreeThread {
  return { id: ThreadId.make(id), projectId: project, worktreePath };
}

describe("findWorktreeSiblingThreadIds", () => {
  it("returns no siblings for a thread that owns its worktree", () => {
    const threads = [thread("a", "/repo/wt-a"), thread("b", "/repo/wt-b")];

    expect(
      findWorktreeSiblingThreadIds({ threadId: ThreadId.make("a"), threads, projects }),
    ).toEqual([]);
    expect(worktreeIsShared({ threadId: ThreadId.make("a"), threads, projects })).toBe(false);
  });

  it("finds every other thread pointed at the same worktree", () => {
    const threads = [
      thread("a", "/repo/shared"),
      thread("b", "/repo/shared"),
      thread("c", "/repo/shared"),
      thread("d", "/repo/elsewhere"),
    ];

    expect(
      findWorktreeSiblingThreadIds({ threadId: ThreadId.make("a"), threads, projects }),
    ).toEqual([ThreadId.make("b"), ThreadId.make("c")]);
  });

  it("treats differently spelled paths to one directory as shared", () => {
    const threads = [thread("a", "C:\\repo\\shared"), thread("b", "c:/repo/shared/")];

    expect(worktreeIsShared({ threadId: ThreadId.make("a"), threads, projects })).toBe(true);
  });

  it("resolves a worktree-less thread to its project workspace root", () => {
    const threads = [thread("a", null), thread("b", "/repo/main")];

    expect(
      findWorktreeSiblingThreadIds({ threadId: ThreadId.make("a"), threads, projects }),
    ).toEqual([ThreadId.make("b")]);
  });

  it("does not pair worktree-less threads from different projects", () => {
    const threads = [thread("a", null), thread("b", null, otherProjectId)];

    expect(worktreeIsShared({ threadId: ThreadId.make("a"), threads, projects })).toBe(false);
  });

  it("returns no siblings when the thread's cwd cannot be resolved", () => {
    const threads = [thread("a", null, ProjectId.make("project-gone")), thread("b", "/repo/main")];

    expect(
      findWorktreeSiblingThreadIds({ threadId: ThreadId.make("a"), threads, projects }),
    ).toEqual([]);
  });

  it("returns no siblings when the thread is absent from the list", () => {
    const threads = [thread("b", "/repo/shared")];

    expect(
      findWorktreeSiblingThreadIds({ threadId: ThreadId.make("a"), threads, projects }),
    ).toEqual([]);
  });
});
