import { FolderGit2Icon, FolderGitIcon, FolderIcon, HistoryIcon } from "lucide-react";
import { memo, useMemo } from "react";

import {
  resolveCurrentWorkspaceLabel,
  resolveEnvModeLabel,
  resolveLockedWorkspaceLabel,
  type EnvMode,
} from "./BranchToolbar.logic";
import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "./ui/select";

export const PREVIOUS_WORKTREE_SELECT_VALUE = "previous-worktree";
const JOIN_WORKTREE_VALUE_PREFIX = "join-worktree:";
const NEW_WORKTREE_ROOT_VALUE_PREFIX = "new-worktree-root:";

export interface BattleDestinationOption {
  /** Worktree path to join, or repo root to cut a new worktree from. */
  readonly value: string;
  readonly label: string;
}

interface BranchToolbarEnvModeSelectorProps {
  envLocked: boolean;
  effectiveEnvMode: EnvMode;
  activeWorktreePath: string | null;
  onEnvModeChange: (mode: EnvMode) => void;
  previousWorktreeLabel?: string | null;
  onUsePreviousWorktree?: () => void;
  /** Sibling worktrees of the draft's battle, joinable as-is. */
  joinWorktrees?: readonly BattleDestinationOption[];
  onJoinWorktree?: (worktreePath: string) => void;
  /** Repo roots to cut a new worktree from; only offered for multi-repo
      project folders, where "which repo" has no obvious answer. */
  newWorktreeRoots?: readonly BattleDestinationOption[];
  onSelectNewWorktreeRoot?: (repoRoot: string) => void;
}

export const BranchToolbarEnvModeSelector = memo(function BranchToolbarEnvModeSelector({
  envLocked,
  effectiveEnvMode,
  activeWorktreePath,
  onEnvModeChange,
  previousWorktreeLabel,
  onUsePreviousWorktree,
  joinWorktrees,
  onJoinWorktree,
  newWorktreeRoots,
  onSelectNewWorktreeRoot,
}: BranchToolbarEnvModeSelectorProps) {
  const showPreviousWorktree = Boolean(previousWorktreeLabel && onUsePreviousWorktree);
  const joinOptions = onJoinWorktree ? (joinWorktrees ?? []) : [];
  const newWorktreeRootOptions = onSelectNewWorktreeRoot ? (newWorktreeRoots ?? []) : [];
  const envModeItems = useMemo(
    () => [
      { value: "local", label: resolveCurrentWorkspaceLabel(activeWorktreePath) },
      { value: "worktree", label: resolveEnvModeLabel("worktree") },
      ...(showPreviousWorktree && previousWorktreeLabel
        ? [{ value: PREVIOUS_WORKTREE_SELECT_VALUE, label: previousWorktreeLabel }]
        : []),
      ...joinOptions.map((option) => ({
        value: `${JOIN_WORKTREE_VALUE_PREFIX}${option.value}`,
        label: option.label,
      })),
      ...newWorktreeRootOptions.map((option) => ({
        value: `${NEW_WORKTREE_ROOT_VALUE_PREFIX}${option.value}`,
        label: option.label,
      })),
    ],
    [
      activeWorktreePath,
      joinOptions,
      newWorktreeRootOptions,
      previousWorktreeLabel,
      showPreviousWorktree,
    ],
  );

  if (envLocked) {
    return (
      <span
        className="inline-flex h-7 shrink-0 items-center gap-1 border border-transparent px-[calc(--spacing(3)-1px)] text-sm font-medium text-muted-foreground/70 sm:h-6 sm:text-xs"
        data-composer-context-control
      >
        {activeWorktreePath ? (
          <>
            <FolderGitIcon className="size-3" />
            {resolveLockedWorkspaceLabel(activeWorktreePath)}
          </>
        ) : (
          <>
            <FolderIcon className="size-3" />
            {resolveLockedWorkspaceLabel(activeWorktreePath)}
          </>
        )}
      </span>
    );
  }

  return (
    <Select
      modal={false}
      value={effectiveEnvMode}
      onValueChange={(value: string | null) => {
        if (value === PREVIOUS_WORKTREE_SELECT_VALUE) {
          onUsePreviousWorktree?.();
          return;
        }
        if (value?.startsWith(JOIN_WORKTREE_VALUE_PREFIX)) {
          onJoinWorktree?.(value.slice(JOIN_WORKTREE_VALUE_PREFIX.length));
          return;
        }
        if (value?.startsWith(NEW_WORKTREE_ROOT_VALUE_PREFIX)) {
          onSelectNewWorktreeRoot?.(value.slice(NEW_WORKTREE_ROOT_VALUE_PREFIX.length));
          return;
        }
        onEnvModeChange(value as EnvMode);
      }}
      items={envModeItems}
    >
      <SelectTrigger
        variant="ghost"
        size="xs"
        className="min-w-0 shrink font-medium"
        aria-label="Workspace"
        data-composer-context-control
      >
        {effectiveEnvMode === "worktree" ? (
          <FolderGit2Icon className="size-3" />
        ) : activeWorktreePath ? (
          <FolderGitIcon className="size-3" />
        ) : (
          <FolderIcon className="size-3" />
        )}
        <span
          data-composer-label
          className="min-w-0 max-w-[240px] group-data-[compact]/composer-context:max-w-0"
        >
          <span
            data-composer-label-motion
            className="block w-full min-w-0 max-w-[240px] origin-left truncate transition-[opacity,transform] duration-180 ease-[cubic-bezier(0.32,0.72,0,1)] group-data-[compact]/composer-context:[transform:translateX(-0.25rem)_scaleX(0.95)] group-data-[compact]/composer-context:opacity-0 motion-reduce:transform-none motion-reduce:transition-opacity"
          >
            <SelectValue />
          </span>
        </span>
      </SelectTrigger>
      <SelectPopup>
        <SelectGroup>
          <SelectGroupLabel>Workspace</SelectGroupLabel>
          <SelectItem value="local">
            <span className="inline-flex items-center gap-1.5">
              {activeWorktreePath ? (
                <FolderGitIcon className="size-3" />
              ) : (
                <FolderIcon className="size-3" />
              )}
              {resolveCurrentWorkspaceLabel(activeWorktreePath)}
            </span>
          </SelectItem>
          <SelectItem value="worktree">
            <span className="inline-flex items-center gap-1.5">
              <FolderGit2Icon className="size-3" />
              {resolveEnvModeLabel("worktree")}
            </span>
          </SelectItem>
          {showPreviousWorktree && previousWorktreeLabel ? (
            <SelectItem value={PREVIOUS_WORKTREE_SELECT_VALUE}>
              <span className="inline-flex items-center gap-1.5">
                <HistoryIcon className="size-3" />
                {previousWorktreeLabel}
              </span>
            </SelectItem>
          ) : null}
        </SelectGroup>
        {joinOptions.length > 0 ? (
          <SelectGroup>
            <SelectGroupLabel>Join a battle worktree</SelectGroupLabel>
            {joinOptions.map((option) => (
              <SelectItem key={option.value} value={`${JOIN_WORKTREE_VALUE_PREFIX}${option.value}`}>
                <span className="inline-flex items-center gap-1.5">
                  <FolderGit2Icon className="size-3" />
                  {option.label}
                </span>
              </SelectItem>
            ))}
          </SelectGroup>
        ) : null}
        {newWorktreeRootOptions.length > 0 ? (
          <SelectGroup>
            <SelectGroupLabel>New worktree from</SelectGroupLabel>
            {newWorktreeRootOptions.map((option) => (
              <SelectItem
                key={option.value}
                value={`${NEW_WORKTREE_ROOT_VALUE_PREFIX}${option.value}`}
              >
                <span className="inline-flex items-center gap-1.5">
                  <FolderGit2Icon className="size-3" />
                  {option.label}
                </span>
              </SelectItem>
            ))}
          </SelectGroup>
        ) : null}
      </SelectPopup>
    </Select>
  );
});
