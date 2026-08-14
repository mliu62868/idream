// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  INCIDENT_CORRELATION_ATTEMPT_MISSING_DISCARD_CONFIRMATION,
  INCIDENT_CORRELATION_REPLAY_CONFIRMATION,
  incidentCorrelationOutboxAttemptMissingDiscardResultSchema,
  incidentCorrelationOutboxEventListResponseSchema,
  incidentCorrelationOutboxReplayResultSchema,
} from "@idream/shared/admin";

const { adminV2Operation } = vi.hoisted(() => ({
  adminV2Operation: vi.fn(),
}));

vi.mock("@/lib/admin-v2-operation", () => ({ adminV2Operation }));

import {
  IncidentCorrelationOutbox,
} from "./IncidentCorrelationOutbox";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const eligible = {
  id: "generation_incident_correlation_attempt-1",
  eventType: "generation.incident.correlate.v2" as const,
  aggregateType: "generation_attempt",
  aggregateId: "attempt-1",
  status: "failed" as const,
  attempts: 8,
  attemptId: "attempt-1",
  attemptStatus: "failed",
  replayEligibility: "eligible" as const,
  lastErrorCode: "incident_correlation_failed",
  lastErrorMessage: "temporary database outage",
  payloadHash: "a".repeat(64),
  nextRunAt: "2026-08-11T12:01:00.000Z",
  createdAt: "2026-08-11T11:59:00.000Z",
  updatedAt: "2026-08-11T12:00:00.000Z",
};
const missingAttempt = {
  ...eligible,
  id: "generation_incident_correlation_attempt-missing",
  aggregateId: "attempt-missing",
  attemptId: "attempt-missing",
  attemptStatus: null,
  replayEligibility: "attempt_missing" as const,
  payloadHash: "b".repeat(64),
};
const initialResponse = outboxResponse([eligible, missingAttempt]);
const emptyResponse = outboxResponse([]);
const replayResponse = incidentCorrelationOutboxReplayResultSchema.parse({
  results: [{
    id: eligible.id,
    outcome: "requeued",
    priorAttempts: eligible.attempts,
    payloadHash: eligible.payloadHash,
  }],
  requeuedCount: 1,
  replayed: false,
});
const discardAttemptMissingResponse =
  incidentCorrelationOutboxAttemptMissingDiscardResultSchema.parse({
    id: missingAttempt.id,
    outcome: "discarded_target_missing",
    priorAttempts: missingAttempt.attempts,
    payloadHash: missingAttempt.payloadHash,
    replayed: false,
  });
const idempotencyKey = "22222222-2222-4222-8222-222222222222";

describe("IncidentCorrelationOutbox mounted operator flow", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    adminV2Operation.mockReset();
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(idempotencyKey);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it("queues only the exact eligible carrier and refreshes the authority list", async () => {
    let reads = 0;
    adminV2Operation.mockImplementation(async (operation: string) => {
      if (operation === "GET /api/v2/admin/incidents/correlation-outbox") {
        reads += 1;
        return reads === 1 ? initialResponse : emptyResponse;
      }
      if (
        operation ===
        "POST /api/v2/admin/incidents/correlation-outbox/commands/replay"
      ) return replayResponse;
      throw new Error(`Unexpected Admin v2 operation: ${operation}`);
    });

    await act(async () => {
      root.render(<IncidentCorrelationOutbox canRead canReplay />);
    });
    await waitUntil(() =>
      container.querySelector<HTMLInputElement>(
        `input[aria-label="Select failed incident correlation event ${eligible.id}"]`,
      ) !== null,
    );
    const eligibleCheckbox = container.querySelector<HTMLInputElement>(
      `input[aria-label="Select failed incident correlation event ${eligible.id}"]`,
    );
    const blockedCheckbox = container.querySelector<HTMLInputElement>(
      `input[aria-label="Select failed incident correlation event ${missingAttempt.id}"]`,
    );
    expect(eligibleCheckbox?.disabled).toBe(false);
    expect(blockedCheckbox?.disabled).toBe(true);

    await click(eligibleCheckbox);
    await click(findButton("Replay selected", container));
    const dialog = await waitForDialog();
    await enter(
      dialog.querySelector<HTMLInputElement>('input[aria-label="Replay reason (≥3)"]'),
      "Postgres recovered",
    );
    await enter(
      dialog.querySelector<HTMLInputElement>('input[aria-label="Replay confirmation"]'),
      INCIDENT_CORRELATION_REPLAY_CONFIRMATION,
    );
    await click(findButton("Queue replay", dialog));

    await waitUntil(() => reads === 2);
    expect(adminV2Operation).toHaveBeenNthCalledWith(
      2,
      "POST /api/v2/admin/incidents/correlation-outbox/commands/replay",
      {
        body: {
          events: [{
            id: eligible.id,
            expectedAttempts: eligible.attempts,
            expectedUpdatedAt: eligible.updatedAt,
            expectedPayloadHash: eligible.payloadHash,
          }],
          reason: { code: "operator_replay", summary: "Postgres recovered" },
          confirmation: INCIDENT_CORRELATION_REPLAY_CONFIRMATION,
        },
        idempotencyKey,
      },
    );
    expect(container.textContent).toContain("requeued: 1");
    expect(container.textContent).toContain("No failed incident correlation deliveries");
  });

  it("records attempt-missing separately and retries the same exact command", async () => {
    let reads = 0;
    let writes = 0;
    adminV2Operation.mockImplementation(async (operation: string) => {
      if (operation === "GET /api/v2/admin/incidents/correlation-outbox") {
        reads += 1;
        return reads === 1 ? initialResponse : emptyResponse;
      }
      if (
        operation ===
        "POST /api/v2/admin/incidents/correlation-outbox/commands/discard-attempt-missing"
      ) {
        writes += 1;
        if (writes === 1) throw new Error("temporary command transport failure");
        return discardAttemptMissingResponse;
      }
      throw new Error(`Unexpected Admin v2 operation: ${operation}`);
    });

    await act(async () => {
      root.render(
        <IncidentCorrelationOutbox
          canDiscardAttemptMissing
          canRead
          canReplay
        />,
      );
    });
    await waitUntil(() =>
      findButton("Record source authority missing", container) !== null,
    );
    await click(findButton("Record source authority missing", container));
    const dialog = await waitForDialog();
    await enter(
      dialog.querySelector<HTMLInputElement>('input[aria-label="Disposition reason (≥3)"]'),
      "GenerationAttempt was never persisted",
    );
    await enter(
      dialog.querySelector<HTMLInputElement>('input[aria-label="Disposition confirmation"]'),
      INCIDENT_CORRELATION_ATTEMPT_MISSING_DISCARD_CONFIRMATION,
    );
    await click(findButton("Record terminal disposition", dialog));
    await waitUntil(() =>
      dialog.textContent?.includes("temporary command transport failure") === true,
    );
    await click(findButton("Record terminal disposition", dialog));

    await waitUntil(() => reads === 2);
    expect(adminV2Operation).toHaveBeenNthCalledWith(
      2,
      "POST /api/v2/admin/incidents/correlation-outbox/commands/discard-attempt-missing",
      {
        body: {
          id: missingAttempt.id,
          expectedAttempts: missingAttempt.attempts,
          expectedUpdatedAt: missingAttempt.updatedAt,
          expectedPayloadHash: missingAttempt.payloadHash,
          expectedAttemptId: missingAttempt.attemptId,
          reason: {
            code: "source_authority_missing",
            summary: "GenerationAttempt was never persisted",
          },
          confirmation: INCIDENT_CORRELATION_ATTEMPT_MISSING_DISCARD_CONFIRMATION,
        },
        idempotencyKey,
      },
    );
    expect(adminV2Operation).toHaveBeenNthCalledWith(
      3,
      "POST /api/v2/admin/incidents/correlation-outbox/commands/discard-attempt-missing",
      expect.objectContaining({ idempotencyKey }),
    );
    expect(container.textContent).toContain(
      "discarded_target_missing",
    );
    expect(container.textContent).toContain(
      "No failed incident correlation deliveries",
    );
  });
});

function outboxResponse(items: readonly (typeof eligible | typeof missingAttempt)[]) {
  return incidentCorrelationOutboxEventListResponseSchema.parse({
    items,
    pageInfo: { endCursor: null, hasNextPage: false },
    asOf: "2026-08-11T12:02:00.000Z",
    freshness: "fresh",
  });
}

function findButton(label: string, rootNode: ParentNode = document) {
  return [...rootNode.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent?.trim() === label,
  ) ?? null;
}

async function click(element: HTMLElement | null) {
  expect(element).not.toBeNull();
  await act(async () => {
    element?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

async function enter(input: HTMLInputElement | null, value: string) {
  expect(input).not.toBeNull();
  await act(async () => {
    if (!input) return;
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function waitForDialog() {
  await waitUntil(() => document.querySelector('[role="dialog"]') !== null);
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
  if (!dialog) throw new Error("Incident correlation replay dialog did not mount");
  return dialog;
}

async function waitUntil(predicate: () => boolean) {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for IncidentCorrelationOutbox state");
    }
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}
