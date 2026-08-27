import type { BattleId, EnvironmentId } from "@t3tools/contracts";
import { RefreshCwIcon } from "lucide-react";
import { memo, useCallback } from "react";

import { requestConfirmDialog } from "../../confirmDialog";
import { battleEnvironment } from "../../state/battles";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const REFRESH_CONFIRM_MESSAGE =
  "Start a fresh orchestrator for this battle? This conversation is archived, not deleted — you can still read it from Settings → Archived.";

/**
 * Retires a battle's orchestrator and starts a fresh one. It only renders on an
 * orchestrator thread, so every other composer is unchanged.
 *
 * An empty orchestrator refreshes on the click: there is no conversation to
 * lose, and asking would be friction for nothing.
 */
export const ComposerRefreshOrchestratorButton = memo(
  function ComposerRefreshOrchestratorButton(props: {
    readonly environmentId: EnvironmentId;
    readonly battleId: BattleId;
    readonly hasConversation: boolean;
    readonly compact: boolean;
  }) {
    const { battleId, compact, environmentId, hasConversation } = props;
    const refreshOrchestrator = useAtomCommand(
      battleEnvironment.refreshOrchestrator,
      "composer:battle:refresh-orchestrator",
    );

    const handleRefresh = useCallback(() => {
      void (async () => {
        if (hasConversation) {
          const confirmation = requestConfirmDialog(REFRESH_CONFIRM_MESSAGE, {
            variant: "destructive",
          });
          // No dialog host mounted means nothing can answer, so the click stands.
          if (confirmation !== undefined && !(await confirmation)) return;
        }
        await refreshOrchestrator({ environmentId, input: { battleId } });
      })();
    }, [battleId, environmentId, hasConversation, refreshOrchestrator]);

    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              size="sm"
              variant="ghost"
              aria-label="Start a fresh orchestrator"
              onClick={handleRefresh}
              className="shrink-0 gap-2 px-2 text-secondary-label"
            />
          }
        >
          <RefreshCwIcon className="size-4" />
          {compact ? null : "Fresh orchestrator"}
        </TooltipTrigger>
        <TooltipPopup side="top">
          Archive this conversation and start a fresh orchestrator
        </TooltipPopup>
      </Tooltip>
    );
  },
);
