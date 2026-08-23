/**
 * Shared vocabulary for the battle orchestrator thread.
 *
 * The MCP toolkit mints the ids and the reactor reads them back, so the two
 * only agree through this module. Keeping the marker in the message id — and
 * not in reactor memory — is what lets report-back survive a restart: the
 * event log already records which member turns the orchestrator started.
 *
 * @module battleOrchestrator
 */
import { MessageId, type BattleId } from "@t3tools/contracts";

/** Title given to every orchestrator thread when the reactor creates it. */
export const ORCHESTRATOR_THREAD_TITLE = "Orchestrator";

const ORCHESTRATOR_SEND_MESSAGE_PREFIX = "battle-orchestrator-send";

/**
 * Message id for a turn the orchestrator started in one of its members. The
 * battle id rides along so a settle can be attributed without a second read.
 */
export const orchestratorSendMessageId = (input: {
  readonly battleId: BattleId;
  readonly uuid: string;
}): MessageId =>
  MessageId.make(`${ORCHESTRATOR_SEND_MESSAGE_PREFIX}:${input.battleId}:${input.uuid}`);

/**
 * The battle whose orchestrator started this message, or null when a user (or
 * anything else) started it. Guard 1 of report-back is exactly this check.
 */
export const battleIdFromOrchestratorSendMessageId = (messageId: string): string | null => {
  if (!messageId.startsWith(`${ORCHESTRATOR_SEND_MESSAGE_PREFIX}:`)) {
    return null;
  }
  const rest = messageId.slice(ORCHESTRATOR_SEND_MESSAGE_PREFIX.length + 1);
  const separator = rest.lastIndexOf(":");
  return separator <= 0 ? null : rest.slice(0, separator);
};
