import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type { BattleId, EnvironmentId, ProjectId } from "@t3tools/contracts";
import { SwordsIcon } from "lucide-react";
import { memo, useCallback, useMemo, useState, type FormEvent } from "react";

import { battleEnvironment, useBattles } from "../state/battles";
import { useAtomCommand } from "../state/use-atom-command";
import { newBattleId } from "~/lib/utils";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogClose,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { toastManager } from "./ui/toast";
import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "./ui/select";

const NO_BATTLE_VALUE = "no-battle";
const NEW_BATTLE_VALUE = "new-battle";

interface BranchToolbarBattleSelectorProps {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  battleId: BattleId | null;
  onBattleChange: (battleId: BattleId | null) => void;
}

/**
 * Which battle a draft enlists in, chosen up to the first send. Threads
 * outside a battle keep the plain flow: "No battle" is the default and stays
 * one click away.
 */
export const BranchToolbarBattleSelector = memo(function BranchToolbarBattleSelector({
  environmentId,
  projectId,
  battleId,
  onBattleChange,
}: BranchToolbarBattleSelectorProps) {
  const battles = useBattles();
  const projectBattles = useMemo(
    () =>
      battles.filter(
        (battle) =>
          battle.environmentId === environmentId &&
          battle.projectId === projectId &&
          battle.phase !== "defeated",
      ),
    [battles, environmentId, projectId],
  );
  const createBattle = useAtomCommand(battleEnvironment.create, { reportFailure: false });
  const [newBattleOpen, setNewBattleOpen] = useState(false);
  const [newBattleTitle, setNewBattleTitle] = useState("");
  const [newBattleGoal, setNewBattleGoal] = useState("");

  const items = useMemo(
    () => [
      { value: NO_BATTLE_VALUE, label: "No battle" },
      ...projectBattles.map((battle) => ({ value: battle.id, label: battle.title })),
      { value: NEW_BATTLE_VALUE, label: "New battle…" },
    ],
    [projectBattles],
  );

  const submitNewBattle = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const title = newBattleTitle.trim();
      if (title.length === 0) return;
      const goal = newBattleGoal.trim();
      const createdBattleId = newBattleId();
      setNewBattleOpen(false);
      setNewBattleTitle("");
      setNewBattleGoal("");
      void createBattle({
        environmentId,
        input: {
          battleId: createdBattleId,
          projectId,
          title,
          ...(goal.length > 0 ? { goal } : {}),
        },
      }).then((result: AtomCommandResult<unknown, unknown>) => {
        if (result._tag === "Failure") {
          if (isAtomCommandInterrupted(result)) return;
          const error = squashAtomCommandFailure(result);
          toastManager.add({
            type: "error",
            title: "Failed to create battle",
            description: error instanceof Error ? error.message : "An error occurred.",
          });
          return;
        }
        // Binding waits for the server to accept the battle, so a failed
        // create never leaves the draft pointing at a battle that isn't there.
        onBattleChange(createdBattleId);
      });
    },
    [createBattle, environmentId, newBattleGoal, newBattleTitle, onBattleChange, projectId],
  );

  return (
    <>
      <Select
        modal={false}
        value={battleId ?? NO_BATTLE_VALUE}
        onValueChange={(value: string | null) => {
          if (value === NEW_BATTLE_VALUE) {
            setNewBattleOpen(true);
            return;
          }
          onBattleChange(value === NO_BATTLE_VALUE || value === null ? null : (value as BattleId));
        }}
        items={items}
      >
        <SelectTrigger
          variant="ghost"
          size="xs"
          className="min-w-0 shrink font-medium"
          aria-label="Battle"
          data-composer-context-control
        >
          <SwordsIcon className="size-3" />
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
            <SelectGroupLabel>Battle</SelectGroupLabel>
            {items.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectPopup>
      </Select>
      <Dialog open={newBattleOpen} onOpenChange={setNewBattleOpen}>
        <DialogPopup>
          <form onSubmit={submitNewBattle}>
            <DialogHeader>
              <DialogTitle>New battle</DialogTitle>
            </DialogHeader>
            <div className="space-y-2 py-2">
              <Input
                autoFocus
                value={newBattleTitle}
                onChange={(event) => setNewBattleTitle(event.currentTarget.value)}
                aria-label="Battle name"
                placeholder="Battle name"
              />
              <Input
                value={newBattleGoal}
                onChange={(event) => setNewBattleGoal(event.currentTarget.value)}
                aria-label="Goal (optional)"
                placeholder="Goal (optional)"
              />
            </div>
            <DialogFooter>
              <DialogClose render={<Button type="button" variant="outline" />}>Cancel</DialogClose>
              <Button type="submit" variant="default" disabled={newBattleTitle.trim().length === 0}>
                Create battle
              </Button>
            </DialogFooter>
          </form>
        </DialogPopup>
      </Dialog>
    </>
  );
});
