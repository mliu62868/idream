import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  CHAT_RUNTIME_DIAGNOSTICS_PATH,
  type ChatRuntimeDiagnostics,
} from "@idream/shared/contracts";

vi.mock("@/server/lib/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/lib/env")>();
  return {
    ...actual,
    env: { ...actual.env, CHAT_SERVICE_URL: "http://chat-ops-runtime.test" },
  };
});

import { GET as chatOverviewRoute } from "@/app/api/v2/admin/chat/overview/route";
import { GET as chatProviderHealthRoute } from "@/app/api/v2/admin/chat/provider-health/route";
import { GET as chatSessionsRoute } from "@/app/api/v2/admin/chat/sessions/route";
import { GET as chatUsageRoute } from "@/app/api/v2/admin/chat/usage/route";
import { GET as chatModerationEventsRoute } from "@/app/api/v2/admin/chat/moderation-events/route";
import { prisma } from "@/server/lib/db";
import { callAdminV2, expectAdminV2Ok } from "@/server/test/admin-v2-client";
import { createUser, purgeTestData } from "@/server/test/helpers";
import { encodeAdminListCursor } from "@/server/modules/admin-v2/shared/list-cursor";

const P = "zt-v2chatops-";
const admin = { userId: `${P}admin`, role: "admin" };
const analyst = { userId: `${P}analyst`, role: "analyst" };
const customerId = `${P}customer`;
const excludedUserId = `${P}excluded-internal`;
const characterId = `${P}character`;
const sessionId = `${P}session`;
const turnId = `${P}turn`;
const originalFetch = globalThis.fetch;
const checkedAt = "2026-09-02T09:00:00.000Z";

let diagnosticResponse: () => Response;
const seenRuntimePaths: string[] = [];
const seenRuntimeSignals: AbortSignal[] = [];

function runtimeDiagnostic(): ChatRuntimeDiagnostics {
  return {
    version: 1,
    service: "chat",
    checkedAt,
    sourceRevision: "0123456789abcdef",
    runtime: {
      accepting: true,
      warmed: true,
      fileStore: true,
      redis: true,
      agentRuntime: true,
      fresh: true,
      observedAt: checkedAt,
      reason: null,
    },
    provider: {
      adapter: "openai",
      model: "qwen-test",
      endpoint: "http://model.internal/v1",
    },
  };
}

describe("Admin v2 Main-owned Chat operations", () => {
  beforeAll(async () => {
    await purgeTestData(P);
    await createUser({ id: admin.userId, role: "admin", dataClass: "internal" });
    await createUser({ id: analyst.userId, role: "analyst", dataClass: "internal" });
    await createUser({ id: customerId, dataClass: "customer" });
    await createUser({ id: excludedUserId, dataClass: "internal" });
    await prisma.character.create({
      data: {
        id: characterId,
        creatorId: customerId,
        name: "Ops Companion",
        age: 28,
        description: "Chat Ops authority fixture",
        visibility: "private",
        status: "approved",
        appearance: {},
        advancedDetails: {},
      },
    });
    const now = new Date();
    await prisma.recentChat.createMany({
      data: [
        {
          sessionId,
          userId: customerId,
          characterId,
          title: "Customer conversation",
          status: "active",
          activeKey: `${customerId}:${characterId}`,
          openingMessage: "Welcome.",
          lastMessageAt: now,
        },
        {
          sessionId: `${P}excluded-session`,
          userId: excludedUserId,
          characterId,
          title: "Internal fixture conversation",
          status: "active",
          activeKey: `${excludedUserId}:${characterId}`,
          openingMessage: "Internal welcome.",
          lastMessageAt: now,
        },
      ],
    });
    await prisma.chatTurn.createMany({
      data: [
        {
          id: turnId,
          sessionId,
          idempotencyKey: `${P}idempotency`,
          requestHash: `${P}hash`,
          userMessageId: `${P}user-message`,
          assistantMessageId: `${P}assistant-message`,
          userContent: "Hello",
          userStatus: "sent",
          assistantContent: "Hello back",
          assistantStatus: "sent",
          model: "qwen-test",
          promptTokens: 10,
          completionTokens: 5,
          memoryEnabled: true,
          terminalAt: now,
        },
        {
          id: `${P}excluded-turn`,
          sessionId: `${P}excluded-session`,
          idempotencyKey: `${P}excluded-idempotency`,
          requestHash: `${P}excluded-hash`,
          userMessageId: `${P}excluded-user-message`,
          assistantMessageId: `${P}excluded-assistant-message`,
          userContent: "Internal",
          userStatus: "sent",
          assistantContent: "Internal reply",
          assistantStatus: "sent",
          memoryEnabled: true,
          terminalAt: now,
        },
      ],
    });
    const productDay = new Date(Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
    ));
    await prisma.chatTurnUsageFact.createMany({
      data: [
        { turnId, userId: customerId, productDay, createdAt: now },
        { turnId: `${P}excluded-turn`, userId: excludedUserId, productDay, createdAt: now },
      ],
    });
    await prisma.entitlement.createMany({
      data: [
        { userId: customerId, key: "unlimited_messages", value: true, source: "test" },
        { userId: customerId, key: "voice_enabled", value: true, source: "test" },
        { userId: customerId, key: "premium_controls", value: true, source: "test" },
      ],
    });
    await prisma.moderationEvent.createMany({
      data: [
        {
          id: `${P}moderation`,
          targetType: "chat_turn",
          targetId: turnId,
          layer: "input",
          status: "blocked",
          policyCode: "fixture_policy",
          confidence: 0.9,
          details: {},
          createdAt: now,
        },
        {
          id: `${P}excluded-moderation`,
          targetType: "chat_turn",
          targetId: `${P}excluded-turn`,
          layer: "input",
          status: "blocked",
          details: {},
          createdAt: now,
        },
      ],
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      if (url.host !== "chat-ops-runtime.test") return originalFetch(input, init);
      seenRuntimePaths.push(url.pathname);
      if (init?.signal) seenRuntimeSignals.push(init.signal);
      return diagnosticResponse();
    });
  });

  afterEach(() => {
    seenRuntimePaths.length = 0;
    seenRuntimeSignals.length = 0;
    diagnosticResponse = () => Response.json(runtimeDiagnostic());
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await purgeTestData(P);
    await prisma.$disconnect();
  });

  it("gates every view on chat.ops.read", async () => {
    const denied = await callAdminV2(chatOverviewRoute, {
      url: "/api/v2/admin/chat/overview",
      actor: analyst,
    });
    expect(denied.status).toBe(403);
  });

  it("reads sessions, usage, moderation and overview from Main without calling Chat", async () => {
    const sessions = expectAdminV2Ok(await callAdminV2(chatSessionsRoute, {
      url: "/api/v2/admin/chat/sessions",
      actor: admin,
      query: { userId: customerId, status: "active" },
    }));
    expect(sessions.data).toMatchObject({
      configured: true,
      items: [{
        id: sessionId,
        userId: customerId,
        messageCount: 3,
        lastMessageId: `${P}assistant-message`,
        lastMessageStatus: "sent",
        lastTokenCount: 15,
      }],
    });

    const usage = expectAdminV2Ok(await callAdminV2(chatUsageRoute, {
      url: "/api/v2/admin/chat/usage",
      actor: admin,
      query: { userId: customerId },
    }));
    expect(usage.data).toMatchObject({
      configured: true,
      freeDailyLimit: 30,
      items: [{
        userId: customerId,
        modelTier: "premium",
        unlimitedMessages: true,
        voiceEnabled: true,
        messagesUsed: 1,
        activeSessions: 1,
        messages24h: 3,
      }],
    });

    const moderation = expectAdminV2Ok(await callAdminV2(chatModerationEventsRoute, {
      url: "/api/v2/admin/chat/moderation-events",
      actor: admin,
      query: { targetId: turnId },
    }));
    expect(moderation.data.items).toEqual([
      expect.objectContaining({ id: `${P}moderation`, targetId: turnId }),
    ]);

    const overview = expectAdminV2Ok(await callAdminV2(chatOverviewRoute, {
      url: "/api/v2/admin/chat/overview",
      actor: admin,
    }));
    expect(overview.data).toMatchObject({
      configured: true,
      overview: {
        freeDailyLimit: 30,
        dataScope: {
          userAuthority: "main.users",
          includedDataClass: "customer",
        },
      },
    });
    expect(overview.data.overview.activeSessions).toBeGreaterThanOrEqual(1);
    expect(overview.data.overview.messages24h).toBeGreaterThanOrEqual(3);
    expect(overview.data.overview.dataScope.excluded.activeSessions).toBeGreaterThanOrEqual(1);
    expect(seenRuntimePaths).toEqual([]);
  });

  it("consumes only the shared narrow Chat runtime diagnostics path", async () => {
    diagnosticResponse = () => Response.json(runtimeDiagnostic());
    const result = expectAdminV2Ok(await callAdminV2(chatProviderHealthRoute, {
      url: "/api/v2/admin/chat/provider-health",
      actor: admin,
    }));
    expect(seenRuntimePaths).toEqual([CHAT_RUNTIME_DIAGNOSTICS_PATH]);
    expect(seenRuntimeSignals).toHaveLength(1);
    expect(seenRuntimeSignals[0]?.aborted).toBe(false);
    expect(result.data).toMatchObject({
      configured: true,
      checkedAt,
      items: [
        { provider: "chat_model", adapter: "openai", model: "qwen-test", ok: true },
        { provider: "chat_moderation", ok: true },
      ],
    });
  });

  it("surfaces a missing diagnostics producer instead of accepting a mocked legacy path", async () => {
    diagnosticResponse = () => Response.json({ error: "not_found" }, { status: 404 });
    const result = expectAdminV2Ok(await callAdminV2(chatProviderHealthRoute, {
      url: "/api/v2/admin/chat/provider-health",
      actor: admin,
    }));
    expect(seenRuntimePaths).toEqual([CHAT_RUNTIME_DIAGNOSTICS_PATH]);
    expect(result.data).toMatchObject({
      configured: false,
      diagnostics: { reason: "upstream_error", status: 404 },
      items: [{ provider: "chat_moderation" }],
    });
  });

  it("rejects a query the manifest does not declare", async () => {
    const result = await callAdminV2(chatSessionsRoute, {
      url: "/api/v2/admin/chat/sessions",
      actor: admin,
      query: { status: "mystery" },
    });
    expect(result.status).toBe(400);
  });

  it("rejects a cursor with the right scope but the wrong key shape", async () => {
    const cursor = encodeAdminListCursor("chat_ops_sessions", {
      userId: undefined,
      characterId: undefined,
      status: "all",
    }, ["only-one-key"]);
    const result = await callAdminV2(chatSessionsRoute, {
      url: "/api/v2/admin/chat/sessions",
      actor: admin,
      query: { cursor },
    });
    expect(result.status).toBe(400);
    expect(result.error?.code).toBe("bad_request");
  });

  it("projects deleted sessions as empty because Main hard-deletes them", async () => {
    const result = expectAdminV2Ok(await callAdminV2(chatSessionsRoute, {
      url: "/api/v2/admin/chat/sessions",
      actor: admin,
      query: { status: "deleted" },
    }));
    expect(result.data).toMatchObject({
      configured: true,
      items: [],
      pageInfo: { hasNextPage: false, endCursor: null },
    });
  });
});
