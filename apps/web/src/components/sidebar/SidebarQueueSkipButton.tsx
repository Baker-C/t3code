import {
  QUEUE_SKIP_UNAVAILABLE_LABEL,
  queueRowKey,
} from "@t3tools/client-runtime/state/battle-queue";
import { BattleId, EnvironmentId } from "@t3tools/contracts";
import { useParams } from "@tanstack/react-router";
import { memo, useCallback, useMemo } from "react";

import { useClientSettings } from "../../hooks/useSettings";
import { battleEnvironment } from "../../state/battles";
import { useQueueRows, useQueueSkipAvailability } from "../../state/battleQueue";
import { useAtomCommand } from "../../state/use-atom-command";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";

/**
 * Passes the battle you are in over for the rest of the lap. It sits with the
 * utility icons rather than in the queue itself so it stays reachable once the
 * queue is scrolled or the list is long, and it is disabled — with the reason —
 * whenever skipping would not take you anywhere.
 */
export const SidebarQueueSkipButton = memo(function SidebarQueueSkipButton() {
  const queueEnabled = useClientSettings((s) => s.battleQueueEnabled);
  const projectPriorityEnabled = useClientSettings((s) => s.battleQueueProjectPriorityEnabled);
  const battlePriorityEnabled = useClientSettings((s) => s.battleQueueBattlePriorityEnabled);
  const roundRobinEnabled = useClientSettings((s) => s.battleQueueRoundRobinEnabled);
  const priorityOptions = useMemo(
    () => ({ battlePriorityEnabled, projectPriorityEnabled }),
    [battlePriorityEnabled, projectPriorityEnabled],
  );
  const rows = useQueueRows(priorityOptions);
  const routeBattleParams = useParams({
    strict: false,
    select: (params) =>
      typeof params.battleId === "string" && typeof params.environmentId === "string"
        ? { battleId: params.battleId, environmentId: params.environmentId }
        : null,
  });
  const currentKey =
    routeBattleParams === null
      ? null
      : queueRowKey(
          EnvironmentId.make(routeBattleParams.environmentId),
          BattleId.make(routeBattleParams.battleId),
        );
  const cycleOptions = useMemo(
    () => ({ currentKey, roundRobinEnabled }),
    [currentKey, roundRobinEnabled],
  );
  const availability = useQueueSkipAvailability(rows, cycleOptions);
  const skipBattle = useAtomCommand(battleEnvironment.queueSkip, "sidebar:battle:queue-skip");
  const handleSkip = useCallback(() => {
    if (!availability.canSkip || routeBattleParams === null) return;
    void skipBattle({
      environmentId: EnvironmentId.make(routeBattleParams.environmentId),
      input: { battleId: BattleId.make(routeBattleParams.battleId) },
    });
  }, [availability.canSkip, routeBattleParams, skipBattle]);

  // Nothing queued means nothing to pass over, and an always-dead control in
  // the footer would be worse than no control at all.
  if (!queueEnabled || rows.length === 0 || !roundRobinEnabled) return null;

  return (
    <SidebarMenuItem className="min-w-0 shrink-0">
      <Tooltip>
        <TooltipTrigger
          render={
            <SidebarMenuButton
              aria-label="Skip this battle"
              disabled={!availability.canSkip}
              onClick={handleSkip}
              className="w-auto px-2 text-xs"
            >
              <span>Skip</span>
            </SidebarMenuButton>
          }
        />
        <TooltipPopup side="top">
          {availability.canSkip
            ? "Pass this battle over for the rest of the lap"
            : QUEUE_SKIP_UNAVAILABLE_LABEL[availability.reason]}
        </TooltipPopup>
      </Tooltip>
    </SidebarMenuItem>
  );
});
