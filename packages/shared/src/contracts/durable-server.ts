import { createHash } from "node:crypto";
import { canonicalJson, type DurableEventEnvelope, type GenerationTerminalRecord } from "./durable";

// INVARIANT: synchronous hashes are server-only; browser contracts import only schemas.
/** The receiver hashes the complete immutable envelope, excluding only its identity key. */
export function durableEnvelopeHash(envelope: DurableEventEnvelope): string {
  return createHash("sha256")
    .update(canonicalJson({
      eventType: envelope.eventType,
      schemaVersion: envelope.schemaVersion,
      occurredAt: envelope.occurredAt,
      aggregateType: envelope.aggregateType,
      aggregateId: envelope.aggregateId,
      payload: envelope.payload,
    }))
    .digest("hex");
}

export function generationTerminalRecordChecksum(record: GenerationTerminalRecord): string {
  return createHash("sha256").update(canonicalJson(record)).digest("hex");
}
