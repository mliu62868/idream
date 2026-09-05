import { describe, expect, it } from "vitest";
import {
  findAdminV2ApiOperation,
  MAIN_TO_CHAT_REPLAY_CONFIRMATION,
  MAIN_TO_CHAT_TARGET_MISSING_CONFIRMATION,
  mainToChatOutboxReplayRequestSchema,
  mainToChatOutboxTargetMissingDispositionRequestSchema,
} from "../index";
import type {
  MainToChatOutboxEvent,
  MainToChatOutboxEventListResponse,
} from "../index";

describe("Main to Chat outbox Admin contracts", () => {
  it("requires explicit unique failed-event identities", () => {
    const event = {
      id: "event-1",
      expectedAttempts: 8,
      expectedUpdatedAt: "2026-08-11T12:00:00.000Z",
    };
    expect(mainToChatOutboxReplayRequestSchema.safeParse({
      events: [event, event],
      reason: { code: "operator_replay", summary: "Chat ingest recovered" },
      confirmation: MAIN_TO_CHAT_REPLAY_CONFIRMATION,
    }).success).toBe(false);
    expect(mainToChatOutboxReplayRequestSchema.safeParse({
      events: [event],
      reason: { code: "operator_replay", summary: "Chat ingest recovered" },
      confirmation: MAIN_TO_CHAT_REPLAY_CONFIRMATION,
    }).success).toBe(true);
  });

  it("binds reads and writes to distinct least-privilege permission sets", () => {
    expect(findAdminV2ApiOperation(
      "GET",
      "/api/v2/admin/chat/main-outbox-events",
    )).toMatchObject({
      authorization: {
        kind: "all_of",
        permissions: ["chat.ops.read", "ops.queue.read"],
      },
    });
    expect(findAdminV2ApiOperation(
      "POST",
      "/api/v2/admin/chat/main-outbox-events/commands/replay",
    )).toMatchObject({
      authorization: {
        kind: "all_of",
        permissions: ["chat.ops.read", "ops.deadletter.write"],
      },
      mutation: {
        commandType: "chat.main_outbox.replay",
        executionMode: "atomic",
      },
    });
    expect(findAdminV2ApiOperation(
      "POST",
      "/api/v2/admin/chat/main-outbox-events/commands/discard-target-missing",
    )).toMatchObject({
      authorization: {
        kind: "all_of",
        permissions: ["chat.ops.read", "ops.deadletter.write"],
      },
      mutation: {
        commandType: "chat.main_outbox.discard_target_missing",
        executionMode: "atomic",
      },
    });
  });

  it("binds a target-missing decision to envelope hash, target, reason, and confirmation", () => {
    const event = {
      id: "event-1",
      expectedAttempts: 8,
      expectedUpdatedAt: "2026-08-11T12:00:00.000Z",
      expectedEnvelopeHash: "a".repeat(64),
      expectedTarget: { kind: "attachment", id: "attachment-1" },
    };
    expect(mainToChatOutboxTargetMissingDispositionRequestSchema.safeParse({
      events: [event],
      reason: { code: "receiver_target_missing", summary: "Receiver target is absent" },
      confirmation: MAIN_TO_CHAT_TARGET_MISSING_CONFIRMATION,
    }).success).toBe(true);
    expect(mainToChatOutboxTargetMissingDispositionRequestSchema.safeParse({
      events: [event, event],
      reason: { code: "receiver_target_missing", summary: "Receiver target is absent" },
      confirmation: MAIN_TO_CHAT_TARGET_MISSING_CONFIRMATION,
    }).success).toBe(false);
  });

  it("exports inferred list and event contracts through the Admin barrel", () => {
    const response = {
      items: [],
      pageInfo: { endCursor: null, hasNextPage: false },
      asOf: "2026-08-11T12:00:00.000Z",
      freshness: "fresh",
    } satisfies MainToChatOutboxEventListResponse;
    const events: readonly MainToChatOutboxEvent[] = response.items;

    expect(events).toEqual([]);
  });
});
