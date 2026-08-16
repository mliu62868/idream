import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  MAIN_TO_CHAT_REPLAY_CONFIRMATION,
  MAIN_TO_CHAT_TARGET_MISSING_CONFIRMATION,
} from "@idream/shared/admin";
import {
  ChatOpsOverviewCards,
  ChatOpsWorkspace,
  mainToChatReplayPayload,
  mainToChatTargetMissingPayload,
  summarizeMainToChatReplay,
} from "./ChatOpsWorkspace";

describe("Chat Ops workspace permissions", () => {
  it("renders five independent authority states and explicit no-permission status", () => {
    const html = renderToStaticMarkup(<ChatOpsWorkspace canRead={false} />);
    expect(html).toContain("Overview: loading");
    expect(html).toContain("Provider health: loading");
    expect(html).toContain("Sessions: loading");
    expect(html).toContain("Usage: loading");
    expect(html).toContain("Events: loading");
    expect(html).toContain("chat.ops.read is not granted");
  });

  it("renders unavailable overview metrics as dashes instead of fabricated zeroes", () => {
    const html = renderToStaticMarkup(<ChatOpsOverviewCards overview={null} />);

    expect(html.match(/>—</g)).toHaveLength(8);
    expect(html).not.toContain(">0<");
  });

  it("shows the Main to Chat queue permission independently from Chat read access", () => {
    const html = renderToStaticMarkup(
      <ChatOpsWorkspace canRead canReadMainOutbox={false} />,
    );

    expect(html).toContain("Main → Chat failed delivery");
    expect(html).toContain("ops.queue.read is not granted");
  });

  it("pins replay commands to the exact failed row revisions", () => {
    expect(
      mainToChatReplayPayload(
        [
          {
            id: "event-1",
            eventType: "chat.image.failed",
            aggregateType: "generation_job",
            aggregateId: "job-1",
            status: "failed",
            attempts: 8,
            lastErrorMessage: "chat durable ingest returned 503",
            envelopeHash: "a".repeat(64),
            storedEnvelopeHash: "b".repeat(64),
            receiverAuthority: {
              disposition: "target_present",
              target: { kind: "attachment", id: "attachment-1" },
              targetStatus: "failed",
              receiptId: null,
              receiptStatus: null,
              checkedAt: "2026-08-11T12:34:57.000Z",
            },
            nextRunAt: "2026-08-11T12:35:26.000Z",
            deliveredAt: null,
            createdAt: "2026-08-11T12:30:00.000Z",
            updatedAt: "2026-08-11T12:34:56.000Z",
          },
        ],
        "  Receiver is ready  ",
      ),
    ).toEqual({
      events: [
        {
          id: "event-1",
          expectedAttempts: 8,
          expectedUpdatedAt: "2026-08-11T12:34:56.000Z",
        },
      ],
      reason: { code: "operator_replay", summary: "Receiver is ready" },
      confirmation: MAIN_TO_CHAT_REPLAY_CONFIRMATION,
    });
  });

  it("pins a target-missing disposition to the receiver target and envelope hash", () => {
    const event = {
      id: "event-1",
      eventType: "chat.image.failed",
      aggregateType: "generation_job",
      aggregateId: "job-1",
      status: "failed" as const,
      attempts: 8,
      lastErrorMessage: "chat durable ingest returned 503",
      envelopeHash: "a".repeat(64),
      storedEnvelopeHash: "b".repeat(64),
      nextRunAt: "2026-08-11T12:35:26.000Z",
      deliveredAt: null,
      createdAt: "2026-08-11T12:30:00.000Z",
      updatedAt: "2026-08-11T12:34:56.000Z",
      receiverAuthority: {
        disposition: "expected_target_missing" as const,
        target: { kind: "attachment" as const, id: "attachment-1" },
        targetStatus: null,
        receiptId: null,
        receiptStatus: null,
        checkedAt: "2026-08-11T12:34:57.000Z",
      },
    };
    expect(mainToChatTargetMissingPayload([event], "  Target deleted before callback  "))
      .toEqual({
        events: [{
          id: "event-1",
          expectedAttempts: 8,
          expectedUpdatedAt: "2026-08-11T12:34:56.000Z",
          expectedEnvelopeHash: "a".repeat(64),
          expectedTarget: { kind: "attachment", id: "attachment-1" },
        }],
        reason: {
          code: "receiver_target_missing",
          summary: "Target deleted before callback",
        },
        confirmation: MAIN_TO_CHAT_TARGET_MISSING_CONFIRMATION,
      });
  });

  it("reports every authority outcome instead of implying the whole batch succeeded", () => {
    expect(
      summarizeMainToChatReplay([
        { outcome: "stale" },
        { outcome: "requeued" },
        { outcome: "requeued" },
        { outcome: "already_delivered" },
      ]),
    ).toBe("already_delivered: 1 · requeued: 2 · stale: 1");
  });
});
