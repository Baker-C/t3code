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
import type {
  BattleId,
  EnvironmentId,
  ProjectId,
  VictoryCondition,
  VictoryConditionId,
  VictoryConditionState,
} from "@t3tools/contracts";
import { SwordsIcon } from "lucide-react";
import { memo, useCallback, useMemo, useState, type FormEvent } from "react";

import { battleEnvironment, useBattle } from "../../state/battles";
import { useThreadShellsForProjectRefs } from "../../state/entities";
import { useAtomCommand } from "../../state/use-atom-command";
import { cn, newVictoryConditionId } from "~/lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Menu, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "../ui/menu";
import { toastManager } from "../ui/toast";

export const PHASE_LABEL: Record<ResolvedBattlePhase, string> = {
  scoping: "Drawing battle lines",
  linesDrawn: "Battle lines drawn",
  fighting: "Fighting",
  defeated: "Defeated",
};

export const CONDITION_GLYPH: Record<VictoryConditionState, string> = {
  scoped: "✓",
  scoping: "●",
  unscoped: "○",
  descoped: "✕",
};

export const CONDITION_GLYPH_CLASS: Record<VictoryConditionState, string> = {
  scoped: "text-success",
  scoping: "text-primary",
  unscoped: "text-muted-foreground/40",
  descoped: "text-muted-foreground/40",
};

export const CONDITION_STATE_LABEL: Record<VictoryConditionState, string> = {
  scoped: "Scoped",
  scoping: "Scoping",
  unscoped: "Unscoped",
  descoped: "Descoped",
};

/** Size lands as a plain number; a provisional estimate wears a tilde so a
    guess never reads as a settled score. */
export function formatSizeScore(condition: VictoryCondition): string | null {
  if (condition.sizeScore === null) return null;
  return condition.sizeProvisional ? `~${condition.sizeScore}` : `${condition.sizeScore}`;
}

interface BattleConditionsProps {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  battleId: BattleId;
}

function useBattleConditions({ environmentId, projectId, battleId }: BattleConditionsProps) {
  const battle = useBattle(environmentId, battleId);
  const projectRefs = useMemo(
    () => [scopeProjectRef(environmentId, projectId)],
    [environmentId, projectId],
  );
  const projectThreads = useThreadShellsForProjectRefs(projectRefs);
  const titleByThreadId = useMemo(
    () => new Map(projectThreads.map((thread) => [thread.id, thread.title] as const)),
    [projectThreads],
  );
  return { battle, titleByThreadId };
}

export const BattleConditionsBadge = memo(function BattleConditionsBadge({
  environmentId,
  projectId,
  battleId,
  expanded,
  onToggle,
  placement = "tab",
}: BattleConditionsProps & {
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly placement?: "inline" | "tab";
}) {
  const { battle } = useBattleConditions({ environmentId, projectId, battleId });
  if (battle === null) return null;

  const progress = battleScopeProgress(battle);
  const label = `Victory conditions: ${progress.scoped} of ${progress.total} scoped`;

  if (placement === "inline") {
    return (
      <Button
        size="micro"
        variant="ghost-muted"
        aria-expanded={expanded}
        aria-label={label}
        className="shrink-0 gap-1 px-1.5"
        onClick={onToggle}
        onPointerDown={(event) => event.preventDefault()}
      >
        <SwordsIcon aria-hidden className="size-3 shrink-0" />
        <span className="max-w-24 truncate">{battle.title}</span>
        <span className="font-medium tabular-nums text-muted-foreground">
          {progress.scoped}/{progress.total}
        </span>
      </Button>
    );
  }

  return (
    <div
      className="chat-composer-shoulder-tab absolute -top-7 left-4 z-0 flex h-8 w-52 items-center gap-1 rounded-t-xl border border-b-0 px-2 pb-1 text-xs leading-none text-muted-foreground"
      data-composer-battle-badge="true"
    >
      <button
        type="button"
        aria-expanded={expanded}
        aria-label={label}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 self-stretch text-muted-foreground hover:text-foreground"
        onClick={onToggle}
        onPointerDown={(event) => event.preventDefault()}
      >
        <SwordsIcon aria-hidden className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate text-left font-medium text-foreground/80">
          {battle.title}
        </span>
        <span className="shrink-0 font-medium tabular-nums">
          {progress.scoped}/{progress.total}
        </span>
      </button>
    </div>
  );
});

export const BattleConditionsDrawer = memo(function BattleConditionsDrawer({
  environmentId,
  projectId,
  battleId,
  onCollapse,
}: BattleConditionsProps & { readonly onCollapse: () => void }) {
  const { battle, titleByThreadId } = useBattleConditions({
    environmentId,
    projectId,
    battleId,
  });
  const addCondition = useAtomCommand(battleEnvironment.addCondition, { reportFailure: false });
  const updateCondition = useAtomCommand(battleEnvironment.updateCondition, {
    reportFailure: false,
  });
  const strikeCondition = useAtomCommand(battleEnvironment.strikeCondition, {
    reportFailure: false,
  });
  const [newConditionTitle, setNewConditionTitle] = useState("");

  const reportFailure = useCallback(<A, E>(result: AtomCommandResult<A, E>) => {
    if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
    const error = squashAtomCommandFailure(result);
    toastManager.add({
      type: "error",
      title: "Failed to update victory condition",
      description: error instanceof Error ? error.message : "An error occurred.",
    });
  }, []);

  const setConditionState = useCallback(
    (conditionId: VictoryConditionId, state: VictoryConditionState) => {
      if (state === "descoped") {
        void strikeCondition({
          environmentId,
          input: { battleId, conditionId, strikeReason: "Descoped from the composer" },
        }).then(reportFailure);
        return;
      }
      void updateCondition({
        environmentId,
        input: { battleId, conditionId, state },
      }).then(reportFailure);
    },
    [battleId, environmentId, reportFailure, strikeCondition, updateCondition],
  );

  const submitNewCondition = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const title = newConditionTitle.trim();
      if (title.length === 0) return;
      setNewConditionTitle("");
      void addCondition({
        environmentId,
        input: { battleId, conditionId: newVictoryConditionId(), title },
      }).then(reportFailure);
    },
    [addCondition, battleId, environmentId, newConditionTitle, reportFailure],
  );

  if (battle === null) return null;

  const progress = battleScopeProgress(battle);
  const phase = resolveBattlePhase(battle);

  return (
    <div className="chat-composer-top-drawer" data-chat-composer-battle-drawer="true">
      <div className="flex items-center gap-2 px-3 py-1.5 sm:px-4">
        <button
          type="button"
          aria-expanded="true"
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 self-stretch text-left text-xs text-muted-foreground hover:text-foreground"
          onClick={onCollapse}
          onPointerDown={(event) => event.preventDefault()}
        >
          <SwordsIcon aria-hidden className="size-3.5 shrink-0" />
          <span className="min-w-0 truncate font-medium text-foreground">{battle.title}</span>
          <span className="tabular-nums">
            {progress.scoped}/{progress.total}
          </span>
        </button>
        <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
          {PHASE_LABEL[phase]}
        </span>
      </div>
      <div className="space-y-px px-3 pb-2 sm:px-4" role="list">
        {battle.victoryConditions.map((condition) => {
          const owner =
            condition.ownerThreadId === null
              ? null
              : (titleByThreadId.get(condition.ownerThreadId) ?? null);
          const size = formatSizeScore(condition);
          return (
            <div
              key={condition.id}
              className="flex items-baseline gap-2 text-xs leading-5"
              role="listitem"
            >
              <Menu>
                <MenuTrigger
                  render={
                    <button
                      type="button"
                      aria-label={`${condition.title}: ${CONDITION_STATE_LABEL[condition.state]}`}
                      className={cn(
                        "w-3 shrink-0 cursor-pointer text-center font-mono text-[10px]",
                        CONDITION_GLYPH_CLASS[condition.state],
                      )}
                    />
                  }
                >
                  {CONDITION_GLYPH[condition.state]}
                </MenuTrigger>
                <MenuPopup align="start">
                  <MenuRadioGroup
                    value={condition.state}
                    onValueChange={(value) =>
                      setConditionState(condition.id, value as VictoryConditionState)
                    }
                  >
                    {(["unscoped", "scoping", "scoped", "descoped"] as const).map((state) => (
                      <MenuRadioItem key={state} value={state}>
                        {CONDITION_STATE_LABEL[state]}
                      </MenuRadioItem>
                    ))}
                  </MenuRadioGroup>
                </MenuPopup>
              </Menu>
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
              {owner !== null ? (
                <span className="max-w-24 shrink-0 truncate text-[10px] text-muted-foreground/55">
                  {owner}
                </span>
              ) : null}
              <span className="ml-auto w-8 shrink-0 text-right text-[10px] text-sky-600 tabular-nums dark:text-sky-300/80">
                {size}
              </span>
            </div>
          );
        })}
      </div>
      <form className="px-3 pb-4 sm:px-4" onSubmit={submitNewCondition}>
        <Input
          value={newConditionTitle}
          onChange={(event) => setNewConditionTitle(event.currentTarget.value)}
          aria-label="Add a victory condition"
          placeholder="Add a victory condition"
          className="h-7 text-xs"
        />
      </form>
    </div>
  );
});
