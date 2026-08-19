// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAIN_TO_CHAT_REPLAY_CONFIRMATION,
  MAIN_TO_CHAT_TARGET_MISSING_CONFIRMATION,
  mainToChatOutboxEventListResponseSchema,
  mainToChatOutboxReplayResultSchema,
  mainToChatOutboxTargetMissingDispositionResultSchema,
} from "@idream/shared/admin";

const { adminV2Operation, apiGet } = vi.hoisted(() => ({
  adminV2Operation: vi.fn(),
  apiGet: vi.fn(),
}));

vi.mock("@/components/admin/api", () => ({ apiGet }));
vi.mock("@/lib/admin-v2-operation", () => ({ adminV2Operation }));

import { ToastProvider } from "@/components/admin/ui/Toast";
import {
  ChatOpsWorkspace,
} from "./ChatOpsWorkspace";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const pageInfo = { endCursor: null, hasNextPage: false };
const event = mainToChatOutboxEventListResponseSchema.parse({
  items: [
    {
      id: "main-outbox-failed-1",
      eventType: "chat.image.failed",
      aggregateType: "generation_job",
      aggregateId: "generation-job-1",
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
        checkedAt: "2026-08-11T12:35:30.000Z",
      },
      nextRunAt: "2026-08-11T12:35:26.000Z",
      deliveredAt: null,
      createdAt: "2026-08-11T12:30:00.000Z",
      updatedAt: "2026-08-11T12:34:56.000Z",
    },
  ],
  pageInfo,
  asOf: "2026-08-11T12:36:00.000Z",
  freshness: "fresh",
}).items[0]!;
const invalidEvent = {
  ...event,
  id: "main-outbox-invalid-1",
  envelopeHash: null,
  storedEnvelopeHash: "c".repeat(64),
};
const targetMissingEvent = {
  ...event,
  id: "main-outbox-target-missing-1",
  receiverAuthority: {
    ...event.receiverAuthority,
    disposition: "expected_target_missing" as const,
    targetStatus: null,
  },
};
const receiverAlreadyDiscardedEvent = {
  ...targetMissingEvent,
  id: "main-outbox-receiver-already-discarded-1",
  receiverAuthority: {
    ...targetMissingEvent.receiverAuthority,
    disposition: "discarded_target_missing" as const,
    receiptId: "main:main-outbox-receiver-already-discarded-1",
    receiptStatus: "discarded_target_missing",
  },
};
const initialOutboxResponse = outboxResponse([event]);
const emptyOutboxResponse = outboxResponse([]);
const replayResponse = mainToChatOutboxReplayResultSchema.parse({
  results: [
    {
      id: event.id,
      outcome: "requeued",
      priorAttempts: event.attempts,
      envelopeHash: event.envelopeHash,
      storedEnvelopeHash: event.storedEnvelopeHash,
    },
  ],
  requeuedCount: 1,
  replayed: false,
});
const targetMissingResponse =
  mainToChatOutboxTargetMissingDispositionResultSchema.parse({
    results: [{
      id: targetMissingEvent.id,
      outcome: "discarded_target_missing",
      priorAttempts: targetMissingEvent.attempts,
      envelopeHash: targetMissingEvent.envelopeHash,
      storedEnvelopeHash: targetMissingEvent.storedEnvelopeHash,
      target: targetMissingEvent.receiverAuthority.target,
      receiverReceiptId: `main:${targetMissingEvent.id}`,
    }],
    discardedCount: 1,
    replayed: false,
  });
const idempotencyKey = "11111111-1111-4111-8111-111111111111";

const chatReadFixtures = new Map<string, unknown>([
  [
    "/api/v2/admin/chat/overview",
    {
      configured: true,
      overview: {
        activeSessions: 2,
        archivedSessions: 1,
        messages24h: 14,
        moderationEvents24h: 3,
        messagesUsedToday: 12,
        usersAtDailyLimit: 1,
        unlimitedEntitlements: 1,
        blockedModeration24h: 0,
      },
    },
  ],
  [
    "/api/v2/admin/chat/provider-health",
    {
      configured: true,
      items: [
        {
          provider: "local-openai-compatible",
          adapter: "openai-compatible",
          status: "healthy",
          ok: true,
          model: "chat-model",
          endpoint: "configured",
          latencyMs: 18,
          httpStatus: 200,
          modelListed: true,
          error: null,
        },
      ],
    },
  ],
  [
    "/api/v2/admin/chat/sessions?limit=50&status=active",
    {
      configured: true,
      items: [
        {
          id: "session-1",
          userId: "user-1",
          characterId: "character-1",
          title: "Session",
          status: "active",
          memoryEnabled: true,
          messageCount: 4,
          lastMessageRole: "assistant",
          lastMessageStatus: "completed",
          lastSafetyStatus: "passed",
          lastMessageAt: "2026-08-11T12:30:00.000Z",
        },
      ],
      pageInfo,
    },
  ],
  [
    "/api/v2/admin/chat/usage?limit=50",
    {
      configured: true,
      items: [
        {
          userId: "user-1",
          modelTier: "standard",
          unlimitedMessages: false,
          messagesUsed: 12,
          freeDailyLimit: 100,
          freeRemaining: 88,
          quotaStatus: "available",
          activeSessions: 1,
          messages24h: 14,
          periodStart: "2026-08-11T00:00:00.000Z",
        },
      ],
      pageInfo,
    },
  ],
  [
    "/api/v2/admin/chat/moderation-events?limit=50",
    {
      configured: true,
      items: [
        {
          id: "moderation-event-1",
          targetType: "message",
          targetId: "message-1",
          layer: "output",
          status: "passed",
          policyCode: "default",
          confidence: 1,
          createdAt: "2026-08-11T12:30:00.000Z",
        },
      ],
      pageInfo,
    },
  ],
]);

describe("ChatOpsWorkspace Main to Chat failed-delivery operations", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    window.history.replaceState(null, "", "/admin/ops/chat");
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    apiGet.mockReset();
    adminV2Operation.mockReset();
    mockAllChatReads();
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(idempotencyKey);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it("requeues the exact selected revision through the typed operation and refreshes", async () => {
    let reads = 0;
    adminV2Operation.mockImplementation(async (operation: string) => {
      if (operation === "GET /api/v2/admin/chat/main-outbox-events") {
        reads += 1;
        return reads === 1 ? initialOutboxResponse : emptyOutboxResponse;
      }
      if (
        operation ===
        "POST /api/v2/admin/chat/main-outbox-events/commands/replay"
      ) {
        return replayResponse;
      }
      throw new Error(`Unexpected Admin v2 operation: ${operation}`);
    });

    await act(async () => {
      root.render(
        <ToastProvider>
          <ChatOpsWorkspace
            canRead
            canReadMainOutbox
            canReplayMainOutbox
          />
        </ToastProvider>,
      );
    });
    await waitUntil(
      () =>
        container.querySelector<HTMLInputElement>(
          `input[aria-label="Select failed event ${event.id}"]`,
        ) !== null,
    );

    await waitUntil(() => apiGet.mock.calls.length === chatReadFixtures.size);
    expect(apiGet.mock.calls.map(([path]) => path).sort()).toEqual(
      [...chatReadFixtures.keys()].sort(),
    );
    await click(
      container.querySelector<HTMLInputElement>(
        `input[aria-label="Select failed event ${event.id}"]`,
      ),
    );
    await click(findButton("Replay selected", container));

    const dialog = await waitForDialog();
    const submit = findButton("Queue replay", dialog);
    expect(submit?.disabled).toBe(true);
    await enter(
      dialog.querySelector<HTMLInputElement>(
        'input[aria-label="Replay reason (≥3)"]',
      ),
      "Chat receiver is ready",
    );
    await enter(
      dialog.querySelector<HTMLInputElement>(
        'input[aria-label="Replay confirmation"]',
      ),
      MAIN_TO_CHAT_REPLAY_CONFIRMATION,
    );
    expect(submit?.disabled).toBe(false);
    await click(submit);

    await waitUntil(() => reads === 2);
    expect(adminV2Operation).toHaveBeenNthCalledWith(
      2,
      "POST /api/v2/admin/chat/main-outbox-events/commands/replay",
      {
        body: {
          events: [
            {
              id: event.id,
              expectedAttempts: 8,
              expectedUpdatedAt: event.updatedAt,
            },
          ],
          reason: {
            code: "operator_replay",
            summary: "Chat receiver is ready",
          },
          confirmation: MAIN_TO_CHAT_REPLAY_CONFIRMATION,
        },
        idempotencyKey,
      },
    );
    // 命令结果落在 toast 里（挂在 document.body 上），面板顶部不再有横幅。
    expect(document.body.textContent).toContain("requeued: 1");
    expect(container.textContent).toContain(
      "No failed Main → Chat deliveries",
    );
  });

  it("shows expected target missing and records an explicit non-delivery disposition", async () => {
    let reads = 0;
    adminV2Operation.mockImplementation(async (operation: string) => {
      if (operation === "GET /api/v2/admin/chat/main-outbox-events") {
        reads += 1;
        return reads === 1
          ? outboxResponse([targetMissingEvent])
          : emptyOutboxResponse;
      }
      if (
        operation ===
        "POST /api/v2/admin/chat/main-outbox-events/commands/discard-target-missing"
      ) {
        return targetMissingResponse;
      }
      throw new Error(`Unexpected Admin v2 operation: ${operation}`);
    });

    await act(async () => {
      root.render(
        <ToastProvider>
          <ChatOpsWorkspace
            canRead
            canReadMainOutbox
            canReplayMainOutbox
            canDiscardMissingMainOutbox
          />
        </ToastProvider>,
      );
    });
    await waitUntil(() =>
      container.textContent?.includes("Expected target missing") ?? false,
    );
    await click(container.querySelector<HTMLInputElement>(
      `input[aria-label="Select failed event ${targetMissingEvent.id}"]`,
    ));
    expect(findButton("Replay selected", container)?.disabled).toBe(true);
    await click(findButton("Record target missing", container));

    const dialog = await waitForDialog();
    expect(dialog.textContent).toContain("no user-visible Chat effect was applied");
    const submit = findButton("Record target missing", dialog);
    await enter(
      dialog.querySelector<HTMLInputElement>(
        'input[aria-label="Target-missing reason (≥3)"]',
      ),
      "Attachment was removed before the terminal callback",
    );
    await enter(
      dialog.querySelector<HTMLInputElement>(
        'input[aria-label="Target-missing confirmation"]',
      ),
      MAIN_TO_CHAT_TARGET_MISSING_CONFIRMATION,
    );
    expect(submit?.disabled).toBe(false);
    await click(submit);

    await waitUntil(() => reads === 2);
    expect(adminV2Operation).toHaveBeenNthCalledWith(
      2,
      "POST /api/v2/admin/chat/main-outbox-events/commands/discard-target-missing",
      {
        body: {
          events: [{
            id: targetMissingEvent.id,
            expectedAttempts: targetMissingEvent.attempts,
            expectedUpdatedAt: targetMissingEvent.updatedAt,
            expectedEnvelopeHash: targetMissingEvent.envelopeHash,
            expectedTarget: targetMissingEvent.receiverAuthority.target,
          }],
          reason: {
            code: "receiver_target_missing",
            summary: "Attachment was removed before the terminal callback",
          },
          confirmation: MAIN_TO_CHAT_TARGET_MISSING_CONFIRMATION,
        },
        idempotencyKey,
      },
    );
    expect(document.body.textContent).toContain("discarded_target_missing: 1");
  });

  it("retries only the terminal command after Chat committed before Main", async () => {
    adminV2Operation.mockImplementation(async (operation: string) => {
      if (operation === "GET /api/v2/admin/chat/main-outbox-events") {
        return outboxResponse([receiverAlreadyDiscardedEvent]);
      }
      throw new Error(`Unexpected Admin v2 operation: ${operation}`);
    });

    await act(async () => {
      root.render(
        <ChatOpsWorkspace
          canRead
          canReadMainOutbox
          canReplayMainOutbox
          canDiscardMissingMainOutbox
        />,
      );
    });
    await waitUntil(() =>
      container.textContent?.includes("Target missing already recorded") ?? false,
    );
    const checkbox = container.querySelector<HTMLInputElement>(
      `input[aria-label="Select failed event ${receiverAlreadyDiscardedEvent.id}"]`,
    );
    expect(checkbox?.disabled).toBe(false);
    await click(checkbox);
    expect(findButton("Replay selected", container)?.disabled).toBe(true);
    expect(findButton("Record target missing", container)?.disabled).toBe(false);

    await click(findButton("Record target missing", container));
    const dialog = await waitForDialog();
    expect(dialog.textContent).toContain("no user-visible Chat effect was applied");
  });

  // 表格迁到 DataTable 之后，「收件方状态不安全的行不可勾选」必须还在：全选只收走可动作的那些。
  it("keeps select-all scoped to the rows a command can safely touch", async () => {
    adminV2Operation.mockResolvedValue(outboxResponse([event, invalidEvent]));

    await act(async () => {
      root.render(
        <ToastProvider>
          <ChatOpsWorkspace canRead canReadMainOutbox canReplayMainOutbox />
        </ToastProvider>,
      );
    });
    await waitUntil(() => container.textContent?.includes(invalidEvent.id) ?? false);

    await click(container.querySelector<HTMLInputElement>(
      'input[aria-label="Select all failed Main to Chat events"]',
    ));

    expect(selectCheckbox(event.id)?.checked).toBe(true);
    expect(selectCheckbox(invalidEvent.id)?.checked).toBe(false);
    expect(container.textContent).toContain("1 selected");
    expect(findButton("Replay selected", container)?.disabled).toBe(false);
  });

  function selectCheckbox(id: string) {
    return container.querySelector<HTMLInputElement>(
      `input[aria-label="Select failed event ${id}"]`,
    );
  }

  it("renders failed delivery evidence without selection controls for a read-only operator", async () => {
    adminV2Operation.mockResolvedValue(initialOutboxResponse);

    await act(async () => {
      root.render(
        <ChatOpsWorkspace
          canRead
          canReadMainOutbox
          canReplayMainOutbox={false}
        />,
      );
    });
    await waitUntil(() => container.textContent?.includes(event.id) ?? false);

    expect(
      container.querySelector('input[aria-label="Select all failed Main to Chat events"]'),
    ).toBeNull();
    expect(
      container.querySelector(`input[aria-label="Select failed event ${event.id}"]`),
    ).toBeNull();
    expect(findButton("Replay selected", container)).toBeNull();
    expect(container.textContent).toContain(
      "Replay unavailable · ops.deadletter.write is not granted",
    );
  });

  it("explains why a malformed durable envelope cannot be selected", async () => {
    adminV2Operation.mockResolvedValue(outboxResponse([invalidEvent]));

    await act(async () => {
      root.render(
        <ChatOpsWorkspace
          canRead
          canReadMainOutbox
          canReplayMainOutbox
        />,
      );
    });
    await waitUntil(() => container.textContent?.includes(invalidEvent.id) ?? false);

    const checkbox = container.querySelector<HTMLInputElement>(
      `input[aria-label="Select failed event ${invalidEvent.id}"]`,
    );
    expect(checkbox?.disabled).toBe(true);
    const reasonId = checkbox?.getAttribute("aria-describedby");
    expect(reasonId).toBeTruthy();
    expect(document.getElementById(reasonId ?? "")?.textContent).toContain(
      "Replay unavailable · invalid durable envelope",
    );
  });

  it("does not read Main outbox authority without its independent permission", async () => {
    await act(async () => {
      root.render(<ChatOpsWorkspace canRead={false} />);
    });
    await waitUntil(
      () =>
        container.textContent?.includes("ops.queue.read is not granted") ?? false,
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(apiGet).not.toHaveBeenCalled();
    expect(adminV2Operation).not.toHaveBeenCalled();
  });
});

function outboxResponse(items: readonly (typeof event)[]) {
  return mainToChatOutboxEventListResponseSchema.parse({
    items,
    pageInfo,
    asOf: "2026-08-11T12:36:00.000Z",
    freshness: "fresh",
  });
}

function mockAllChatReads() {
  apiGet.mockImplementation(async (path: string) => {
    if (!chatReadFixtures.has(path)) {
      throw new Error(`Unexpected Chat read: ${path}`);
    }
    return chatReadFixtures.get(path);
  });
}

function findButton(label: string, root: ParentNode = document) {
  return (
    [...root.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) =>
        button.getAttribute("aria-label") === label ||
        button.textContent?.trim() === label,
    ) ?? null
  );
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
  if (!dialog) throw new Error("Main to Chat replay dialog did not mount");
  return dialog;
}

async function waitUntil(predicate: () => boolean) {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for ChatOpsWorkspace state");
    }
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}
