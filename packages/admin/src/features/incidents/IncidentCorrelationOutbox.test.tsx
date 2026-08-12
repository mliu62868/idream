import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  INCIDENT_CORRELATION_REPLAY_CONFIRMATION,
  type IncidentCorrelationOutboxEvent,
} from "@idream/shared/admin";
import {
  IncidentCorrelationOutbox,
  incidentCorrelationReplayPayload,
  summarizeIncidentCorrelationReplay,
} from "./IncidentCorrelationOutbox";

const event: IncidentCorrelationOutboxEvent = {
  id: "generation_incident_correlation_attempt-1",
  eventType: "generation.incident.correlate.v2",
  aggregateType: "generation_attempt",
  aggregateId: "attempt-1",
  status: "failed",
  attempts: 8,
  attemptId: "attempt-1",
  attemptStatus: "failed",
  replayEligibility: "eligible",
  lastErrorCode: "incident_correlation_failed",
  lastErrorMessage: "temporary database outage",
  payloadHash: "a".repeat(64),
  nextRunAt: "2026-08-11T12:01:00.000Z",
  createdAt: "2026-08-11T11:59:00.000Z",
  updatedAt: "2026-08-11T12:00:00.000Z",
};

describe("Incident correlation failed-outbox workspace", () => {
  it("shows its independent read and replay permission boundaries", () => {
    const unreadable = renderToStaticMarkup(
      <IncidentCorrelationOutbox canRead={false} canReplay={false} />,
    );
    expect(unreadable).toContain("Incident correlation failed delivery");
    expect(unreadable).toContain("ops.queue.read is not granted");

    const readOnly = renderToStaticMarkup(
      <IncidentCorrelationOutbox canRead canReplay={false} />,
    );
    expect(readOnly).toContain("ops.deadletter.write is not granted");
  });

  it("pins the operator command to the exact failed row and payload", () => {
    expect(incidentCorrelationReplayPayload([event], "  Postgres recovered  "))
      .toEqual({
        events: [{
          id: event.id,
          expectedAttempts: 8,
          expectedUpdatedAt: event.updatedAt,
          expectedPayloadHash: event.payloadHash,
        }],
        reason: {
          code: "operator_replay",
          summary: "Postgres recovered",
        },
        confirmation: INCIDENT_CORRELATION_REPLAY_CONFIRMATION,
      });
  });

  it("keeps every partial outcome visible to the operator", () => {
    expect(summarizeIncidentCorrelationReplay([
      { outcome: "stale" },
      { outcome: "requeued" },
      { outcome: "attempt_missing" },
      { outcome: "requeued" },
    ])).toBe("attempt_missing: 1 · requeued: 2 · stale: 1");
  });
});
