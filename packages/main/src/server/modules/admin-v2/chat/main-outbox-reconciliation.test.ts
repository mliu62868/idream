import { describe, expect, it } from "vitest";
import {
  MAIN_TO_CHAT_EVENTS,
  durableEnvelopeHash,
  durableEventEnvelopeSchema,
} from "@idream/shared/contracts";
import {
  classifyMainToChatReplay,
  validateMainToChatOutboxEnvelope,
} from "./main-outbox-reconciliation";

function failedImageRow(overrides: Record<string, unknown> = {}) {
  const id = "chat_image_failed_att_1";
  const envelope = {
    sourceService: "main",
    sourceEventId: id,
    eventType: MAIN_TO_CHAT_EVENTS.chatImageFailed,
    schemaVersion: 1,
    occurredAt: "2026-08-11T12:00:00.000Z",
    aggregateType: "chat_effect",
    aggregateId: id,
    payload: {
      version: 1,
      kind: "chat.image.failed",
      attachmentId: "att_1",
      generationJobId: null,
      status: "rejected",
      errorCode: "forbidden",
    },
    ...overrides,
  };
  return {
    row: {
      id,
      eventType: String(envelope.eventType),
      aggregateType: String(envelope.aggregateType),
      aggregateId: String(envelope.aggregateId),
      payload: envelope,
    },
    envelope: durableEventEnvelopeSchema.parse(envelope),
  };
}

describe("Main to Chat failed outbox reconciliation", () => {
  it("rejects a generic envelope whose Chat-consumed payload is malformed", () => {
    const { row } = failedImageRow({
      payload: {
        version: 1,
        kind: "chat.image.failed",
        attachmentId: "att_1",
        status: "mystery",
      },
    });

    expect(validateMainToChatOutboxEnvelope(row)).toEqual({
      valid: false,
      reason: "invalid_payload",
      target: null,
    });
  });

  it("requires reconciliation when neither a receipt nor its target exists", () => {
    const { row } = failedImageRow();
    expect(classifyMainToChatReplay({ row, receipt: null, target: null }))
      .toMatchObject({ disposition: "reconcile_receiver_target_missing" });
  });

  it("allows replay when the receiver target still exists", () => {
    const { row } = failedImageRow();
    expect(classifyMainToChatReplay({
      row,
      receipt: null,
      target: { kind: "attachment", id: "att_1", status: "requesting" },
    })).toMatchObject({ disposition: "replay_receiver_target_present" });
  });

  it("allows sender repair for an exact durable receiver receipt", () => {
    const { row, envelope } = failedImageRow();
    expect(classifyMainToChatReplay({
      row,
      receipt: {
        sourceEventId: row.id,
        payloadHash: durableEnvelopeHash(envelope),
        eventType: envelope.eventType,
        status: "consumed",
        attempts: 0,
      },
      target: null,
    })).toMatchObject({ disposition: "replay_exact_receiver_receipt" });
  });

  it("requires terminal-command retry when Chat committed before Main", () => {
    const { row, envelope } = failedImageRow();
    expect(classifyMainToChatReplay({
      row,
      receipt: {
        sourceEventId: row.id,
        payloadHash: durableEnvelopeHash(envelope),
        eventType: envelope.eventType,
        status: "discarded_target_missing",
        attempts: 0,
      },
      target: null,
    })).toMatchObject({
      disposition: "reconcile_receiver_discarded_target_missing",
    });
  });

  it("fails closed on a receiver hash conflict or quarantine", () => {
    const { row, envelope } = failedImageRow();
    const receipt = {
      sourceEventId: row.id,
      payloadHash: "a".repeat(64),
      eventType: envelope.eventType,
      status: "consumed",
      attempts: 0,
    };
    expect(classifyMainToChatReplay({ row, receipt, target: null }))
      .toMatchObject({ disposition: "reconcile_receiver_hash_conflict" });
    expect(classifyMainToChatReplay({
      row,
      receipt: { ...receipt, status: "quarantined" },
      target: null,
    })).toMatchObject({ disposition: "reconcile_receiver_quarantined" });
  });
});
