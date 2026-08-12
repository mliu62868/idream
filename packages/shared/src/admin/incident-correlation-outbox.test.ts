import { describe, expect, it } from "vitest";
import {
  INCIDENT_CORRELATION_REPLAY_CONFIRMATION,
  incidentCorrelationOutboxEventListResponseSchema,
  incidentCorrelationOutboxReplayRequestSchema,
  incidentCorrelationOutboxReplayResultSchema,
} from "./contracts";
import type {
  IncidentCorrelationOutboxEvent,
  IncidentCorrelationOutboxEventListResponse,
} from "./contracts";

const revision = {
  id: "generation_incident_correlation_attempt-1",
  expectedAttempts: 8,
  expectedUpdatedAt: "2026-08-11T12:00:00.000Z",
  expectedPayloadHash: "a".repeat(64),
};

describe("incident correlation failed-outbox contracts", () => {
  it("exposes the exact failed carrier and its replay authority", () => {
    expect(incidentCorrelationOutboxEventListResponseSchema.parse({
      items: [{
        id: revision.id,
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
        payloadHash: revision.expectedPayloadHash,
        nextRunAt: "2026-08-11T12:01:00.000Z",
        createdAt: "2026-08-11T11:59:00.000Z",
        updatedAt: revision.expectedUpdatedAt,
      }],
      pageInfo: { endCursor: null, hasNextPage: false },
      asOf: "2026-08-11T12:02:00.000Z",
      freshness: "fresh",
    }).items[0]).toMatchObject({
      eventType: "generation.incident.correlate.v2",
      replayEligibility: "eligible",
      payloadHash: revision.expectedPayloadHash,
    });
  });

  it("pins replay to unique exact row revisions and the stored payload hash", () => {
    expect(incidentCorrelationOutboxReplayRequestSchema.parse({
      events: [revision],
      reason: { code: "dependency_recovered", summary: "Postgres is healthy" },
      confirmation: INCIDENT_CORRELATION_REPLAY_CONFIRMATION,
    }).events).toEqual([revision]);

    expect(() => incidentCorrelationOutboxReplayRequestSchema.parse({
      events: [revision, revision],
      reason: { code: "dependency_recovered", summary: "Postgres is healthy" },
      confirmation: INCIDENT_CORRELATION_REPLAY_CONFIRMATION,
    })).toThrow(/unique/i);
  });

  it("reports partial replay outcomes without collapsing them into success", () => {
    expect(incidentCorrelationOutboxReplayResultSchema.parse({
      results: [
        {
          id: revision.id,
          outcome: "requeued",
          priorAttempts: 8,
          payloadHash: revision.expectedPayloadHash,
        },
        {
          id: "generation_incident_correlation_attempt-2",
          outcome: "attempt_missing",
          priorAttempts: 8,
          payloadHash: "b".repeat(64),
        },
      ],
      requeuedCount: 1,
      replayed: false,
    })).toMatchObject({ requeuedCount: 1, replayed: false });
  });

  it("exports inferred list and event contracts through the Admin barrel", () => {
    const response = {
      items: [],
      pageInfo: { endCursor: null, hasNextPage: false },
      asOf: "2026-08-11T12:00:00.000Z",
      freshness: "fresh",
    } satisfies IncidentCorrelationOutboxEventListResponse;
    const events: readonly IncidentCorrelationOutboxEvent[] = response.items;

    expect(events).toEqual([]);
  });
});
