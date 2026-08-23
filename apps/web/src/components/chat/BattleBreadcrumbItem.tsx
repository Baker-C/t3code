import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  battleScopeProgress,
  resolveBattlePhase,
  type ResolvedBattlePhase,
} from "@t3tools/client-runtime/state/battles";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type { BattleId, EnvironmentId, ProjectId } from "@t3tools/contracts";
import { ChevronDownIcon, SwordsIcon } from "lucide-react";
import {
  memo,
  useCallback,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";

import { summarizeBattleWorktrees } from "../battles.logic";
import { battleEnvironment, useBattle } from "../../state/battles";
import { useThreadShellsForProjectRefs } from "../../state/entities";
import { useAtomCommand } from "../../state/use-atom-command";
import { useNewThreadHandler } from "~/hooks/useHandleNewThread";
import { Button } from "../ui/button";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Checkbox } from "../ui/checkbox";
import { Menu, MenuGroup, MenuGroupLabel, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { toastManager } from "../ui/toast";
import { WorkspaceBreadcrumbItem, WorkspaceBreadcrumbSeparator } from "../WorkspaceBreadcrumb";

const PHASE_LABEL: Record<ResolvedBattlePhase, string> = {
  scoping: "Drawing battle lines",
  linesDrawn: "Battle lines drawn",
  fighting: "Fighting",
  defeated: "Defeated",
};

interface BattleBreadcrumbItemProps {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  battleId: BattleId;
  /** Worktree of the thread in view, preselected for a new sibling thread. */
  activeWorktreePath?: string | null;
  activeBranch?: string | null;
}

/**
 * The battle segment of the thread breadcrumb: name, scope progress, and the
 * menu that owns the battle's lifecycle. Renders nothing until the battle is
 * in the shell snapshot, so a projection race never leaves a dangling crumb.
 */
export const BattleBreadcrumbItem = memo(function BattleBreadcrumbItem({
  environmentId,
  projectId,
  battleId,
  activeWorktreePath = null,
  activeBranch = null,
}: BattleBreadcrumbItemProps) {
  const battle = useBattle(environmentId, battleId);
  const projectRefs = useMemo(
    () => [scopeProjectRef(environmentId, projectId)],
    [environmentId, projectId],
  );
  const projectThreads = useThreadShellsForProjectRefs(projectRefs);
  const members = useMemo(
    () => projectThreads.filter((thread) => thread.battleId === battleId),
    [battleId, projectThreads],
  );
  const worktrees = useMemo(() => summarizeBattleWorktrees(members), [members]);

  const updateBattleMetadata = useAtomCommand(battleEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const declareBattleDefeat = useAtomCommand(battleEnvironment.declareDefeat, {
    reportFailure: false,
  });
  const reopenBattle = useAtomCommand(battleEnvironment.reopen, { reportFailure: false });
  const handleNewThread = useNewThreadHandler();

  const [renamingTitle, setRenamingTitle] = useState<string | null>(null);
  const renameCommittedRef = useRef(false);
  const [defeatOpen, setDefeatOpen] = useState(false);
  const [retireWorktrees, setRetireWorktrees] = useState(false);

  const reportFailure = useCallback(<A, E>(title: string, result: AtomCommandResult<A, E>) => {
    if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
    const error = squashAtomCommandFailure(result);
    toastManager.add({
      type: "error",
      title,
      description: error instanceof Error ? error.message : "An error occurred.",
    });
  }, []);

  const commitRename = useCallback(
    (title: string) => {
      setRenamingTitle(null);
      const trimmed = title.trim();
      if (battle === null) return;
      if (trimmed.length === 0) {
        toastManager.add({ type: "warning", title: "Battle title cannot be empty" });
        return;
      }
      if (trimmed === battle.title) return;
      void updateBattleMetadata({
        environmentId,
        input: { battleId, title: trimmed },
      }).then((result) => reportFailure("Failed to rename battle", result));
    },
    [battle, battleId, environmentId, reportFailure, updateBattleMetadata],
  );

  const handleRenameKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>) => {
      if (event.nativeEvent.isComposing || event.keyCode === 229) return;
      if (event.key === "Enter") {
        renameCommittedRef.current = true;
        commitRename(event.currentTarget.value);
      } else if (event.key === "Escape") {
        renameCommittedRef.current = true;
        setRenamingTitle(null);
      }
    },
    [commitRename],
  );

  const confirmDefeat = useCallback(() => {
    setDefeatOpen(false);
    void declareBattleDefeat({
      environmentId,
      input: { battleId, retireWorktrees },
    }).then((result) => reportFailure("Failed to declare defeat", result));
  }, [battleId, declareBattleDefeat, environmentId, reportFailure, retireWorktrees]);

  // A sibling thread starts where this one runs: same worktree, same battle.
  // The destination selector in the composer strip can still move it.
  const newThreadInBattle = useCallback(() => {
    void handleNewThread(scopeProjectRef(environmentId, projectId), {
      battleId,
      ...(activeWorktreePath !== null
        ? { worktreePath: activeWorktreePath, branch: activeBranch, envMode: "worktree" as const }
        : {}),
    });
  }, [activeBranch, activeWorktreePath, battleId, environmentId, handleNewThread, projectId]);

  const reopen = useCallback(() => {
    void reopenBattle({ environmentId, input: { battleId } }).then((result) =>
      reportFailure("Failed to reopen battle", result),
    );
  }, [battleId, environmentId, reopenBattle, reportFailure]);

  if (battle === null) return null;

  const phase = resolveBattlePhase(battle);
  const progress = battleScopeProgress(battle);

  return (
    <>
      <WorkspaceBreadcrumbItem>
        {renamingTitle !== null ? (
          <input
            autoFocus
            aria-label="Battle title"
            className="min-w-0 rounded-sm bg-transparent text-sm font-medium text-foreground outline-none ring-1 ring-ring/50 focus:ring-ring"
            defaultValue={renamingTitle}
            onBlur={(event) => {
              if (renameCommittedRef.current) return;
              commitRename(event.currentTarget.value);
            }}
            onFocus={(event) => event.currentTarget.select()}
            onKeyDown={handleRenameKeyDown}
          />
        ) : (
          <Menu>
            <MenuTrigger
              render={
                <button
                  type="button"
                  aria-label={`Battle actions for ${battle.title}`}
                  className="group/battle-crumb inline-flex min-w-0 cursor-pointer items-center gap-1.5 rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                />
              }
            >
              <SwordsIcon aria-hidden className="size-3.5 shrink-0" />
              <span className="max-w-40 truncate">{battle.title}</span>
              {progress.total > 0 ? (
                <span className="shrink-0 tabular-nums text-muted-foreground/70">
                  {progress.scoped}/{progress.total}
                </span>
              ) : null}
              <ChevronDownIcon
                aria-hidden
                className="size-3.5 shrink-0 opacity-0 transition-opacity group-hover/battle-crumb:opacity-100 group-focus-visible/battle-crumb:opacity-100"
              />
            </MenuTrigger>
            <MenuPopup align="start">
              <MenuGroup>
                <MenuGroupLabel>{PHASE_LABEL[phase]}</MenuGroupLabel>
                {worktrees.lines.map((line) => (
                  <div key={line} className="px-2 py-1 text-xs text-muted-foreground tabular-nums">
                    {line}
                  </div>
                ))}
                {worktrees.localThreadsLabel ? (
                  <div className="px-2 py-1 text-xs text-muted-foreground">
                    {worktrees.localThreadsLabel}
                  </div>
                ) : null}
              </MenuGroup>
              <MenuGroup>
                <MenuItem
                  onClick={() => {
                    renameCommittedRef.current = false;
                    setRenamingTitle(battle.title);
                  }}
                >
                  Rename battle
                </MenuItem>
                <MenuItem onClick={newThreadInBattle}>New thread in battle</MenuItem>
                {phase === "defeated" ? (
                  <MenuItem onClick={reopen}>Reopen battle</MenuItem>
                ) : (
                  <MenuItem
                    onClick={() => {
                      setRetireWorktrees(false);
                      setDefeatOpen(true);
                    }}
                  >
                    Declare defeat
                  </MenuItem>
                )}
              </MenuGroup>
            </MenuPopup>
          </Menu>
        )}
      </WorkspaceBreadcrumbItem>
      <WorkspaceBreadcrumbSeparator />
      <AlertDialog open={defeatOpen} onOpenChange={setDefeatOpen}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Declare {battle.title} defeated?</AlertDialogTitle>
            <AlertDialogDescription>
              {worktrees.branchCount === 0
                ? "This battle holds no worktrees."
                : `Declaring defeat leaves ${worktrees.branchCount === 1 ? "1 branch" : `${worktrees.branchCount} branches`} for you to merge:`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {worktrees.lines.length > 0 ? (
            <ul className="list-none space-y-1 px-1 text-xs text-muted-foreground">
              {worktrees.lines.map((line) => (
                <li key={line}>{line}</li>
              ))}
              {worktrees.localThreadsLabel ? <li>{worktrees.localThreadsLabel}</li> : null}
            </ul>
          ) : null}
          {worktrees.branchCount > 0 ? (
            <label className="flex items-center gap-2 px-1 text-xs text-muted-foreground">
              <Checkbox
                checked={retireWorktrees}
                onCheckedChange={(checked) => setRetireWorktrees(checked === true)}
              />
              Remove the worktrees
            </label>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button variant="default" onClick={confirmDefeat}>
              Declare defeat
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
});
