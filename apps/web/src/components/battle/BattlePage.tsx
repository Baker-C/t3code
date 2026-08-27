import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { battleScopeProgress } from "@t3tools/client-runtime/state/battles";
import type { BattleId, EnvironmentId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ChevronDownIcon, ChevronUpIcon, GitBranchIcon, SwordsIcon } from "lucide-react";
import { memo, useCallback, useMemo, useState, type ReactNode } from "react";

import { isElectron } from "../../env";
import { useBattle, type EnvironmentBattle } from "../../state/battles";
import { useProject, useThreadShellsForProjectRefs } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { environmentShell } from "../../state/shell";
import { cn } from "~/lib/utils";
import { layoutBattleMembers } from "../battles.logic";
import ChatView from "../ChatView";
import {
  CONDITION_GLYPH,
  CONDITION_GLYPH_CLASS,
  CONDITION_STATE_LABEL,
  formatSizeScore,
} from "../chat/BattleConditionsBadge";
import { resolveThreadStatusPill } from "../Sidebar.logic";
import { SidebarInset } from "../ui/sidebar";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "../WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";

function SectionLabel(props: { readonly children: ReactNode }) {
  return (
    <h2 className="text-[13px] font-medium tracking-wide text-muted-foreground uppercase">
      {props.children}
    </h2>
  );
}

/** One enlisted thread; opening it is plain navigation, same as the sidebar. */
const BattleThreadRow = memo(function BattleThreadRow(props: { thread: EnvironmentThreadShell }) {
  const { thread } = props;
  const navigate = useNavigate();
  const pill = resolveThreadStatusPill({ thread });
  return (
    <li className="list-none">
      <button
        type="button"
        onClick={() =>
          void navigate({
            to: "/$environmentId/$threadId",
            params: { environmentId: thread.environmentId, threadId: thread.id },
          })
        }
        className="flex h-8 w-full cursor-pointer items-center gap-2 rounded-md border border-border/60 bg-card px-2.5 text-left text-[15px] outline-none hover:border-border hover:bg-accent focus-visible:ring-1 focus-visible:ring-ring"
      >
        <span className="min-w-0 flex-1 truncate font-medium text-foreground/90">
          {thread.title}
        </span>
        {thread.archivedAt !== null ? (
          <span className="shrink-0 text-[13px] text-muted-foreground/70">Archived</span>
        ) : pill !== null ? (
          <span className={cn("flex shrink-0 items-center gap-1.5 text-[13px]", pill.colorClass)}>
            <span className={cn("size-1.5 rounded-full", pill.dotClass)} />
            {pill.label}
          </span>
        ) : null}
      </button>
    </li>
  );
});

/**
 * The battle context, centered over the orchestrator transcript. It is the
 * chat's scroll header, so it scrolls away as the conversation grows; the top
 * padding matches the timeline's own fade spacer so nothing sits under the
 * topbar mask at rest.
 */
const BattleHero = memo(function BattleHero(props: {
  readonly battle: EnvironmentBattle;
  readonly threads: readonly EnvironmentThreadShell[];
  readonly detailsCollapsed: boolean;
  readonly onToggleDetails: () => void;
}) {
  const { battle, detailsCollapsed, onToggleDetails, threads } = props;
  const progress = battleScopeProgress(battle);
  const memberItems = useMemo(() => layoutBattleMembers(threads), [threads]);
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col items-center gap-3 px-3 pt-5 pb-3 sm:px-5">
      <div className="flex w-full flex-col items-center gap-2 text-center">
        <h2 className="max-w-full truncate text-2xl font-semibold text-foreground">
          {battle.title}
        </h2>
        {!detailsCollapsed && battle.goal !== null ? (
          <p className="m-0 max-w-prose text-base whitespace-pre-wrap text-foreground/85">
            {battle.goal}
          </p>
        ) : null}
      </div>

      {detailsCollapsed ? null : (
        <section className="flex w-full max-w-xl flex-col items-center gap-2">
          <SectionLabel>
            Victory conditions
            {progress.total > 0 ? (
              <span className="ms-2 font-normal normal-case tabular-nums">
                {progress.scoped} of {progress.total} scoped
              </span>
            ) : null}
          </SectionLabel>
          {battle.victoryConditions.length === 0 ? (
            <p className="m-0 text-base text-muted-foreground/70">No victory conditions yet.</p>
          ) : (
            <div className="flex w-full flex-col gap-0.5" role="list">
              {battle.victoryConditions.map((condition) => (
                <div
                  key={condition.id}
                  role="listitem"
                  className="flex items-baseline gap-2 text-base leading-6"
                >
                  <span
                    aria-label={CONDITION_STATE_LABEL[condition.state]}
                    className={cn(
                      "w-3.5 shrink-0 text-center font-mono text-[13px]",
                      CONDITION_GLYPH_CLASS[condition.state],
                    )}
                  >
                    {CONDITION_GLYPH[condition.state]}
                  </span>
                  <span
                    className={cn(
                      "min-w-0 flex-1",
                      condition.state === "descoped"
                        ? "text-muted-foreground/45 line-through"
                        : condition.state === "scoped"
                          ? "text-muted-foreground/70"
                          : "text-foreground/90",
                    )}
                  >
                    {condition.title}
                  </span>
                  <span className="w-8 shrink-0 text-right text-[13px] text-sky-600 tabular-nums dark:text-sky-300/80">
                    {formatSizeScore(condition)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      <section className="flex w-full max-w-xl flex-col items-center gap-2">
        {memberItems.length === 0 ? (
          <p className="m-0 text-base text-muted-foreground/70">
            No threads enlisted yet. Threads join a battle when they are created.
          </p>
        ) : (
          <ul role="list" className="m-0 flex w-full list-none flex-col gap-1 p-0">
            {memberItems.map((item) =>
              item.kind === "worktree-label" ? (
                <li
                  key={`worktree-${item.worktreePath}`}
                  className="mt-1 flex items-center gap-1.5 text-[13px] text-muted-foreground first:mt-0"
                >
                  <GitBranchIcon aria-hidden className="size-3 shrink-0" />
                  <span className="min-w-0 truncate">
                    {item.repoLabel} — {item.branch ?? "detached"}
                  </span>
                </li>
              ) : (
                <BattleThreadRow key={item.thread.id} thread={item.thread} />
              ),
            )}
          </ul>
        )}
      </section>

      <button
        type="button"
        aria-expanded={!detailsCollapsed}
        aria-label={
          detailsCollapsed ? "Show goal and victory conditions" : "Hide goal and victory conditions"
        }
        onClick={onToggleDetails}
        className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground/70 outline-none hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
      >
        {detailsCollapsed ? (
          <ChevronDownIcon aria-hidden className="size-3.5" />
        ) : (
          <ChevronUpIcon aria-hidden className="size-3.5" />
        )}
      </button>
    </div>
  );
});

/** Breadcrumb-only chrome for the states that have no orchestrator chat to show. */
function BattlePageFallback(props: {
  readonly projectTitle: string | null;
  readonly battleTitle: string | null;
  readonly children: ReactNode;
}) {
  return (
    <SidebarInset className="h-svh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground md:h-dvh">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron}>
          <WorkspaceBreadcrumb ariaLabel="Battle breadcrumb" className="min-w-0">
            {props.projectTitle !== null ? (
              <>
                <WorkspaceBreadcrumbItem>
                  <span className="truncate">{props.projectTitle}</span>
                </WorkspaceBreadcrumbItem>
                <WorkspaceBreadcrumbSeparator />
              </>
            ) : null}
            <WorkspaceBreadcrumbItem current>
              <SwordsIcon aria-hidden className="me-1.5 size-3.5 shrink-0" />
              <h1 className="truncate">{props.battleTitle ?? "Battle"}</h1>
            </WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
        </WorkspacePageHeader>
        <div className="min-h-0 flex-1 overflow-y-auto">{props.children}</div>
      </div>
    </SidebarInset>
  );
}

function BattleEmptyState(props: { readonly children: ReactNode }) {
  return (
    <WorkspacePageContainer className="items-center pt-24 text-center">
      <SwordsIcon aria-hidden className="size-6 text-muted-foreground/50" />
      <p className="m-0 text-sm text-muted-foreground">{props.children}</p>
    </WorkspacePageContainer>
  );
}

/**
 * The battle's own page: the orchestrator thread's chat, with the battle
 * context fixed above it. The context is an overlay rather than a scrolling
 * header, so battle state stays on screen through a long conversation.
 * Everything renders from the live shell snapshot, so the page tracks battle
 * and thread changes without any fetch of its own.
 */
export function BattlePage(props: {
  readonly environmentId: EnvironmentId;
  readonly battleId: BattleId;
}) {
  const { battleId, environmentId } = props;
  const battle = useBattle(environmentId, battleId);
  const liveBattle = battle !== null && battle.deletedAt === null ? battle : null;
  const shell = useEnvironmentQuery(environmentShell.stateAtom(environmentId));
  const bootstrapComplete = shell.data?.snapshot._tag === "Some";
  const project = useProject(
    liveBattle === null ? null : scopeProjectRef(environmentId, liveBattle.projectId),
  );
  const projectRefs = useMemo(
    () => (liveBattle === null ? [] : [scopeProjectRef(environmentId, liveBattle.projectId)]),
    [environmentId, liveBattle],
  );
  // Orchestrator threads are filtered out of the shell lists, so these are the
  // members and only the members.
  const projectThreads = useThreadShellsForProjectRefs(projectRefs);
  const memberThreads = useMemo(
    () => projectThreads.filter((thread) => thread.battleId === battleId),
    [battleId, projectThreads],
  );
  // Held here rather than in the hero so the choice survives the timeline
  // swapping its empty-thread branch for the virtualized list.
  const [detailsCollapsed, setDetailsCollapsed] = useState(false);
  const toggleDetails = useCallback(() => setDetailsCollapsed((collapsed) => !collapsed), []);
  const orchestratorThreadId = liveBattle?.orchestratorThreadId ?? null;
  const hero = useMemo(
    () =>
      liveBattle === null ? null : (
        <BattleHero
          battle={liveBattle}
          threads={memberThreads}
          detailsCollapsed={detailsCollapsed}
          onToggleDetails={toggleDetails}
        />
      ),
    [detailsCollapsed, liveBattle, memberThreads, toggleDetails],
  );

  if (liveBattle === null) {
    return (
      <BattlePageFallback projectTitle={null} battleTitle={null}>
        {bootstrapComplete ? (
          <BattleEmptyState>
            This battle no longer exists, or its environment is not connected.
          </BattleEmptyState>
        ) : null}
      </BattlePageFallback>
    );
  }

  if (orchestratorThreadId === null) {
    return (
      <BattlePageFallback projectTitle={project?.title ?? null} battleTitle={liveBattle.title}>
        <BattleEmptyState>
          This battle has no orchestrator thread yet. It appears as soon as the server enlists one.
        </BattleEmptyState>
      </BattlePageFallback>
    );
  }

  return (
    <SidebarInset className="h-svh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground md:h-dvh">
      <ChatView
        environmentId={environmentId}
        threadId={orchestratorThreadId}
        routeKind="server"
        overlay={hero}
      />
    </SidebarInset>
  );
}
