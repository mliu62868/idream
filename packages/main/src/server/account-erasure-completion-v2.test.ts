import { describe, expect, it, vi } from "vitest";
import { CHAT_TO_MAIN_EVENTS } from "@idream/shared/contracts";
import { ACCOUNT_ERASURE_COMPLETION_V2_SOURCE_SERVICE } from "@/processes/event-consumer";
import {
  accountErasureCompletionV2EnvelopeSchema,
  ingestAccountErasureCompletionV2,
} from "./account-erasure-completion-v2";
import { POST as genericIngest } from "@/app/api/internal/events/ingest/route";
import { POST as dedicatedIngest } from "@/app/api/internal/events/account-erasure-completion-v2/ingest/route";
import { env } from "@/server/lib/env";

function envelope() {
  return {
    sourceService: "chat",
    sourceEventId: "chat-account-erasure-completion-1",
    eventType: CHAT_TO_MAIN_EVENTS.accountErasureCompletedV2,
    schemaVersion: 2,
    occurredAt: "2026-08-11T12:00:00.000Z",
    aggregateType: "user",
    aggregateId: "user-1",
    payload: {
      version: 2,
      binding: "request_bound",
      userId: "user-1",
      fileMutationId: "file-mutation-1",
      deletionRequestEventId: "main-account-deletion-request-1",
    },
  } as const;
}

describe("account erasure completion v2 ingress", () => {
  it("uses a dedicated projection receipt namespace before ACK", async () => {
    const apply = vi.fn(async () => ({ status: "applied" as const }));
    await expect(
      ingestAccountErasureCompletionV2(envelope(), apply),
    ).resolves.toEqual({
      acknowledged: true,
      status: "persisted",
      receiptId: "chat-account-erasure-completion-1",
    });
    expect(apply).toHaveBeenCalledWith(expect.objectContaining({
      eventId: "chat-account-erasure-completion-1",
      eventType: CHAT_TO_MAIN_EVENTS.accountErasureCompletedV2,
      schemaVersion: 2,
      sourceService: ACCOUNT_ERASURE_COMPLETION_V2_SOURCE_SERVICE,
      payload: expect.objectContaining({ binding: "request_bound" }),
    }));
  });

  it("ACKs an exact dedicated replay only after the atomic projector reports duplicate", async () => {
    await expect(ingestAccountErasureCompletionV2(
      envelope(),
      async () => ({ status: "duplicate", outcome: "applied" }),
    )).resolves.toEqual({
      acknowledged: true,
      status: "duplicate",
      receiptId: "chat-account-erasure-completion-1",
    });
  });

  it("rejects generic, unbound, and cross-user completion envelopes", () => {
    expect(() => accountErasureCompletionV2EnvelopeSchema.parse({
      ...envelope(),
      sourceService: "chat.account_deletion_v2",
    })).toThrow();
    expect(() => accountErasureCompletionV2EnvelopeSchema.parse({
      ...envelope(),
      aggregateId: "another-user",
    })).toThrow();
    expect(() => accountErasureCompletionV2EnvelopeSchema.parse({
      ...envelope(),
      payload: { ...envelope().payload, binding: "aggregate" },
    })).toThrow();
  });

  it("does not ACK a quarantined completion identity", async () => {
    await expect(ingestAccountErasureCompletionV2(
      envelope(),
      async () => ({ status: "quarantined", reason: "payload_hash_conflict" }),
    )).resolves.toEqual({
      acknowledged: false,
      status: "quarantined",
      receiptId: "chat-account-erasure-completion-1",
    });
  });

  it("rejects v2 on generic ingress and malformed authority on dedicated ingress", async () => {
    const headers = {
      "content-type": "application/json",
      "x-internal-token": env.INTERNAL_TOKEN,
    };
    const generic = await genericIngest(new Request(
      "http://main.internal/api/internal/events/ingest",
      { method: "POST", headers, body: JSON.stringify(envelope()) },
    ));
    expect(generic.status).toBe(409);

    const dedicated = await dedicatedIngest(new Request(
      "http://main.internal/api/internal/events/account-erasure-completion-v2/ingest",
      {
        method: "POST",
        headers,
        body: JSON.stringify({ ...envelope(), aggregateId: "wrong-user" }),
      },
    ));
    expect(dedicated.status).toBe(400);
  });
});
