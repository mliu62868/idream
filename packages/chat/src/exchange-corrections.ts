import {
  CHAT_TO_MAIN_EVENTS,
  chatExchangeCorrectionV2Schema,
  type ChatExchangeCorrectionV2,
} from "@idream/shared/contracts";
import type { Prisma } from "../generated/client/client.js";
import { recordOutbox } from "./outbox.js";

/**
 * Transactional producer seam for a mutation that changes the currently
 * eligible representation of a logical user turn. Callers must invoke this in
 * the same chat DB transaction as the selection/edit/delete/supersede mutation.
 */
export async function recordExchangeCorrection(
  tx: Prisma.TransactionClient,
  input: ChatExchangeCorrectionV2,
): Promise<string> {
  const payload = chatExchangeCorrectionV2Schema.parse(input);
  return recordOutbox(tx, {
    eventType: CHAT_TO_MAIN_EVENTS.exchangeCorrectedV2,
    schemaVersion: 2,
    aggregateType: "exchange",
    aggregateId: payload.exchangeId,
    payload,
  });
}
