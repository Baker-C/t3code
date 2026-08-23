import type { BattleId, EnvironmentId } from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";

import { BattlePage } from "../components/battle/BattlePage";

function BattleRouteView() {
  const params = Route.useParams();
  return (
    <BattlePage
      environmentId={params.environmentId as EnvironmentId}
      battleId={params.battleId as BattleId}
    />
  );
}

export const Route = createFileRoute("/_chat/battles/$environmentId/$battleId")({
  component: BattleRouteView,
});
