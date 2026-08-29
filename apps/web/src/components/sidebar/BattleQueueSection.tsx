import type { QueueRow } from "@t3tools/client-runtime/state/battle-queue";
import type { BattleId, EnvironmentId, QueueAction } from "@t3tools/contracts";
import { ChevronDownIcon, MoreHorizontalIcon } from "lucide-react";
import { memo, useCallback, useMemo, useState } from "react";

import { cn } from "../../lib/utils";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** How many rows stand in for the top slot when nothing is ready. */
const FALLBACK_VISIBLE_COUNT = 3;

export interface BattleQueueSectionProps {
  readonly rows: ReadonlyArray<QueueRow>;
  readonly next: QueueRow | null;
  readonly showEnvironmentLabels: boolean;
  readonly onOpen: (environmentId: EnvironmentId, battleId: BattleId) => void;
  readonly onRemove: (environmentId: EnvironmentId, battleId: BattleId) => void;
  readonly onClearQueue: () => void;
}

function outcomeDotClass(action: QueueAction): string {
  switch (action.outcome) {
    case "completed":
      return "bg-emerald-500 dark:bg-emerald-400";
    case "needs-clarification":
      return "bg-blue-500 dark:bg-blue-400";
    case "errored":
      return "bg-red-500 dark:bg-red-400";
    default:
      return "bg-sidebar-muted-foreground/55";
  }
}

/**
 * One battle's row. The top slot and the rows behind the shelf share this,
 * so the only difference between "next up" and the rest is position.
 */
const BattleQueueRow = memo(function BattleQueueRow(props: {
  row: QueueRow;
  isNext: boolean;
  showEnvironmentLabel: boolean;
  onOpen: (environmentId: EnvironmentId, battleId: BattleId) => void;
  onRemove: (environmentId: EnvironmentId, battleId: BattleId) => void;
}) {
  const { isNext, onOpen, onRemove, row, showEnvironmentLabel } = props;
  const handleOpen = useCallback(
    () => onOpen(row.environmentId, row.battleId),
    [onOpen, row.battleId, row.environmentId],
  );
  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if ((event.target as HTMLElement).closest("button")) return;
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        handleOpen();
      }
    },
    [handleOpen],
  );
  const handleRemove = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      onRemove(row.environmentId, row.battleId);
    },
    [onRemove, row.battleId, row.environmentId],
  );
  const status =
    row.readyActions.length > 0
      ? `${row.readyActions.length} waiting on you`
      : row.pendingActions.length > 0
        ? `${row.pendingActions.length} running`
        : "";
  return (
    <li className="list-none">
      <div
        role="button"
        tabIndex={0}
        aria-label={`${row.battleTitle} queued battle`}
        data-testid="battle-queue-row"
        onClick={handleOpen}
        onKeyDown={handleKeyDown}
        className={cn(
          "group/queue-row cursor-pointer rounded-md px-[var(--sidebar-row-content-inset)] py-1.5 outline-none select-none hover:bg-sidebar-row-hover focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
          // The top slot is the Next control, so it gets the only emphasis in
          // the section; passing a battle over dims it until the lap resets.
          isNext && "bg-sidebar-row-selected ring-1 ring-ring/45 ring-inset",
          row.skippedInLap && !isNext && "opacity-50",
        )}
      >
        <div className="flex h-5 min-w-0 items-center gap-1.5">
          <span className="min-w-0 flex-1 truncate text-xs font-medium text-sidebar-foreground/85">
            {row.battleTitle}
          </span>
          {row.hasErrored ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <span
                    role="img"
                    aria-label="An action errored"
                    className="shrink-0 rounded-full border border-red-500/35 bg-red-500/10 px-1.5 text-[10px] font-medium text-red-600 dark:text-red-400"
                  >
                    !
                  </span>
                }
              />
              <TooltipPopup>An action errored. It keeps its place in the order.</TooltipPopup>
            </Tooltip>
          ) : null}
          <span
            className={cn(
              "shrink-0 rounded-full border px-1.5 text-[10px] font-medium",
              row.state === "ready"
                ? "border-emerald-500/35 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                : row.state === "busy"
                  ? "border-sidebar-border bg-sidebar-control-surface text-sidebar-muted-foreground"
                  : "border-sidebar-border text-sidebar-muted-foreground",
            )}
          >
            {row.state === "ready" ? "Ready" : row.state === "busy" ? "Working" : "Not started"}
          </span>
        </div>
        <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] text-sidebar-muted-foreground">
          <span className="min-w-0 truncate">{row.projectTitle ?? "Unknown project"}</span>
          {showEnvironmentLabel && row.environmentLabel !== "" ? (
            <>
              <span aria-hidden className="opacity-45">
                ·
              </span>
              <span className="shrink-0 truncate rounded-full border border-sidebar-border px-1.5 font-mono text-[10px]">
                {row.environmentLabel}
              </span>
            </>
          ) : null}
          {row.skippedInLap ? (
            <>
              <span aria-hidden className="opacity-45">
                ·
              </span>
              <span className="shrink-0">passed over</span>
            </>
          ) : null}
        </div>
        <div className="mt-1 flex min-w-0 items-center gap-1 text-[11px] text-sidebar-muted-foreground">
          {[...row.readyActions, ...row.pendingActions].map((action) => (
            <span
              key={action.id}
              aria-hidden
              className={cn("size-1.5 shrink-0 rounded-full", outcomeDotClass(action))}
            />
          ))}
          {status === "" ? null : <span className="ms-0.5 truncate">{status}</span>}
          <span className="ms-auto shrink-0">
            <button
              type="button"
              onClick={handleRemove}
              aria-label={`Remove ${row.battleTitle} from the queue`}
              // Hover-only, but focus reveals it too so it is reachable
              // without a pointer.
              className="cursor-pointer rounded-md px-1.5 py-0.5 text-[11px] font-medium opacity-0 transition-opacity hover:bg-red-500/10 hover:text-red-600 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring group-hover/queue-row:opacity-100 dark:hover:text-red-400"
            >
              Remove
            </button>
          </span>
        </div>
      </div>
    </li>
  );
});

/**
 * The battle queue: your focus list, pinned above the search row so it never
 * scrolls away. The battle the cycle would hand you next sits on top and is
 * the Next control — there is no separate button — and everything else sits
 * behind a shelf toggle in queue order.
 */
export const BattleQueueSection = memo(function BattleQueueSection(props: BattleQueueSectionProps) {
  const { next, onClearQueue, onOpen, onRemove, rows, showEnvironmentLabels } = props;
  const [restExpanded, setRestExpanded] = useState(false);
  const toggleRest = useCallback(() => setRestExpanded((open) => !open), []);
  const readyCount = useMemo(() => rows.filter((row) => row.state === "ready").length, [rows]);
  // With nothing ready there is no next, so the top of the list falls back to
  // the first few rows in queue order rather than collapsing to nothing.
  const top = useMemo(
    () => (next === null ? rows.slice(0, FALLBACK_VISIBLE_COUNT) : [next]),
    [next, rows],
  );
  const rest = useMemo(() => rows.filter((row) => !top.includes(row)), [rows, top]);

  return (
    <div className="flex min-h-0 flex-col">
      <div className="flex h-7 items-center gap-1.5 ps-[0.4375rem] pe-1">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-sidebar-muted-foreground">
          Battle queue
        </span>
        <span className="text-[11px] text-sidebar-muted-foreground/70 tabular-nums">
          {readyCount} ready
        </span>
        <span className="ms-auto shrink-0">
          <Menu>
            <MenuTrigger
              render={
                <button
                  type="button"
                  aria-label="Queue options"
                  className="inline-flex size-6 cursor-pointer items-center justify-center rounded-md text-sidebar-muted-foreground outline-none hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring"
                />
              }
            >
              <MoreHorizontalIcon aria-hidden className="size-3.5" />
            </MenuTrigger>
            <MenuPopup align="end">
              <MenuItem disabled={rows.length === 0} onClick={onClearQueue}>
                Clear queue
              </MenuItem>
            </MenuPopup>
          </Menu>
        </span>
      </div>

      {rows.length === 0 ? (
        <p className="px-2.5 pb-2 text-[11px] text-sidebar-muted-foreground">
          Nothing queued. Add a battle from its own page.
        </p>
      ) : (
        <>
          <ul role="list" className="flex flex-col gap-px">
            {top.map((row) => (
              <BattleQueueRow
                key={row.key}
                row={row}
                isNext={next !== null && row.key === next.key}
                showEnvironmentLabel={showEnvironmentLabels}
                onOpen={onOpen}
                onRemove={onRemove}
              />
            ))}
          </ul>
          {rest.length === 0 ? null : (
            <>
              {restExpanded ? (
                <ul role="list" className="flex flex-col gap-px">
                  {rest.map((row) => (
                    <BattleQueueRow
                      key={row.key}
                      row={row}
                      isNext={false}
                      showEnvironmentLabel={showEnvironmentLabels}
                      onOpen={onOpen}
                      onRemove={onRemove}
                    />
                  ))}
                </ul>
              ) : null}
              {/* The same shelf the settled threads use, so a second way to
                  hide rows does not need a second visual language. */}
              <button
                type="button"
                onClick={toggleRest}
                aria-expanded={restExpanded}
                data-testid="battle-queue-shelf-toggle"
                className="mt-1.5 mb-1 flex w-full cursor-pointer items-center gap-2 px-2.5 text-left"
              >
                <span className="text-xs font-medium text-muted-foreground/50">
                  {restExpanded ? "Show less" : `Show more (${rest.length})`}
                </span>
                <span className="h-px flex-1 bg-sidebar-border/60" />
                <ChevronDownIcon
                  aria-hidden
                  className={cn(
                    "size-3 text-muted-foreground/50 transition-transform",
                    restExpanded && "rotate-180",
                  )}
                />
              </button>
            </>
          )}
        </>
      )}
    </div>
  );
});
