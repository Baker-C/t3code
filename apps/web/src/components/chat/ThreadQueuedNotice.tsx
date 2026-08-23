import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { resolveWorktreeMates } from "@t3tools/client-runtime/state/battles";
import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { memo, useMemo } from "react";

import { useThreadShellsForProjectRefs } from "../../state/entities";

interface ThreadQueuedNoticeProps {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  threadId: ThreadId;
  worktreePath: string | null;
}

/**
 * Passive line for a turn waiting on its worktree: threads sharing a worktree
 * take turns, and the wait is a fact to report, not work to animate. Names
 * the thread currently holding the worktree when it can be identified.
 */
export const ThreadQueuedNotice = memo(function ThreadQueuedNotice({
  environmentId,
  projectId,
  threadId,
  worktreePath,
}: ThreadQueuedNoticeProps) {
  const projectRefs = useMemo(
    () => (worktreePath === null ? [] : [scopeProjectRef(environmentId, projectId)]),
    [environmentId, projectId, worktreePath],
  );
  const projectThreads = useThreadShellsForProjectRefs(projectRefs);
  const holder = useMemo(() => {
    const mates = resolveWorktreeMates(projectThreads, { id: threadId, cwd: worktreePath });
    return (
      mates.find(
        (mate) => mate.session?.status === "running" || mate.session?.status === "starting",
      ) ?? null
    );
  }, [projectThreads, threadId, worktreePath]);

  return (
    <p role="status" className="px-4 pb-1 text-xs text-muted-foreground">
      {holder === null
        ? "Waiting for another thread to finish in this worktree"
        : `Waiting for ${holder.title} to finish in this worktree`}
    </p>
  );
});
