import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// SPEC: 这个文件必须在「Chat 已配置」下运行，才能验证代理的四条分支。
// INTENT: `env` 在模块加载时一次性解析自 process.env，`vi.stubEnv` 追不上；改 process.env
//   又会漏给同一 worker 里后续的文件。只覆盖这一个字段、其余透传真实 env，是唯一
//   既确定又不外溢的做法。
vi.mock("@/server/lib/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/lib/env")>();
  return {
    ...actual,
    env: { ...actual.env, CHAT_SERVICE_URL: "http://chat-ops-proxy.test" },
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

const P = "zt-v2chatops-";
const admin = { userId: `${P}admin`, role: "admin" };
const analyst = { userId: `${P}analyst`, role: "analyst" }; // lacks chat.ops.read
const originalFetch = globalThis.fetch;

const sessionRow = {
  id: `${P}session-1`,
  userId: `${P}customer`,
  characterId: `${P}character`,
  title: "Evening talk",
  status: "active",
  memoryEnabled: true,
  messageCount: 12,
  lastMessageId: `${P}message-1`,
  lastMessageRole: "assistant",
  lastMessageStatus: "delivered",
  lastSafetyStatus: "passed",
  lastModel: "qwen3-4b",
  lastTokenCount: 128,
  lastMessageAt: "2026-08-15T09:00:00.000Z",
  createdAt: "2026-08-14T09:00:00.000Z",
  updatedAt: "2026-08-15T09:00:00.000Z",
};

const pageInfo = { hasNextPage: false, endCursor: null };

/** Serves whatever the current test stashed here, keyed by the upstream path. */
let upstream: (path: string, search: string) => Response;

function stubChat(handler: typeof upstream) {
  upstream = handler;
}

describe("Admin v2 Chat Ops proxy", () => {
  beforeAll(async () => {
    await purgeTestData(P);
    await createUser({ id: admin.userId, role: "admin", dataClass: "internal" });
    await createUser({ id: analyst.userId, role: "analyst", dataClass: "internal" });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      if (url.host !== "chat-ops-proxy.test") return originalFetch(input, init);
      return upstream(url.pathname, url.search);
    });
  });

  afterEach(() => {
    upstream = () => Response.json({}, { status: 500 });
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await purgeTestData(P);
    await prisma.$disconnect();
  });

  it("gates every authority on chat.ops.read", async () => {
    stubChat(() => Response.json({ items: [], pageInfo }));
    const denied = await callAdminV2(chatOverviewRoute, {
      url: "/api/v2/admin/chat/overview",
      actor: analyst,
    });
    expect(denied.status).toBe(403);
  });

  it("forwards the declared query and narrows the upstream list to its DTO", async () => {
    const seen: string[] = [];
    stubChat((path, search) => {
      seen.push(`${path}${search}`);
      return Response.json({
        items: [{ ...sessionRow, unexpectedUpstreamField: undefined }],
        pageInfo,
      });
    });

    const result = expectAdminV2Ok(await callAdminV2(chatSessionsRoute, {
      url: "/api/v2/admin/chat/sessions",
      actor: admin,
      query: { userId: `${P}customer`, status: "active", limit: "25" },
    }));
    expect(seen[0]).toContain("/internal/admin/sessions");
    expect(seen[0]).toContain(`userId=${encodeURIComponent(`${P}customer`)}`);
    expect(seen[0]).toContain("status=active");
    expect(seen[0]).toContain("limit=25");
    expect(result.data).toMatchObject({
      configured: true,
      diagnostics: { serviceUrlConfigured: true },
      items: [{ id: sessionRow.id, messageCount: 12 }],
      pageInfo,
    });
  });

  it("degrades to a diagnosed empty answer when the upstream shape is outside the contract", async () => {
    stubChat(() => Response.json({ items: [{ id: "only-an-id" }], pageInfo }));
    const result = expectAdminV2Ok(await callAdminV2(chatSessionsRoute, {
      url: "/api/v2/admin/chat/sessions",
      actor: admin,
    }));
    expect(result.data).toMatchObject({
      configured: false,
      diagnostics: { reason: "contract_mismatch", serviceUrlConfigured: true },
      items: [],
      pageInfo: null,
    });
  });

  it("degrades on an unauthorized or unreachable Chat service instead of failing the panel", async () => {
    stubChat(() => Response.json({ error: "unauthorized" }, { status: 401 }));
    const unauthorized = expectAdminV2Ok(await callAdminV2(chatUsageRoute, {
      url: "/api/v2/admin/chat/usage",
      actor: admin,
    }));
    expect(unauthorized.data).toMatchObject({
      configured: false,
      diagnostics: { reason: "unauthorized", status: 401, serviceUrlConfigured: true },
      freeDailyLimit: null,
      items: [],
      pageInfo: null,
    });

    stubChat(() => {
      throw new TypeError("connect ECONNREFUSED");
    });
    const unreachable = expectAdminV2Ok(await callAdminV2(chatModerationEventsRoute, {
      url: "/api/v2/admin/chat/moderation-events",
      actor: admin,
    }));
    expect(unreachable.data).toMatchObject({
      configured: false,
      diagnostics: { reason: "unreachable", serviceUrlConfigured: true },
      items: [],
      pageInfo: null,
    });
  });

  it("bubbles an upstream 400 as an operator input error", async () => {
    stubChat(() => Response.json({ error: "invalid_cursor" }, { status: 400 }));
    const result = await callAdminV2(chatModerationEventsRoute, {
      url: "/api/v2/admin/chat/moderation-events",
      actor: admin,
      query: { cursor: "not-a-cursor" },
    });
    expect(result.status).toBe(400);
    expect(result.error?.code).toBe("bad_request");
  });

  it("answers provider health with the declared envelope", async () => {
    stubChat(() => Response.json({
      checkedAt: "2026-08-15T09:00:00.000Z",
      items: [
        {
          provider: "chat_model",
          adapter: "mock",
          status: "mock",
          ok: false,
          model: "qwen3-4b",
          endpoint: null,
          latencyMs: null,
          httpStatus: null,
          modelListed: null,
          error: "CHAT_MODEL_PROVIDER=mock",
        },
      ],
    }));
    const result = expectAdminV2Ok(await callAdminV2(chatProviderHealthRoute, {
      url: "/api/v2/admin/chat/provider-health",
      actor: admin,
    }));
    expect(result.data).toMatchObject({
      configured: true,
      checkedAt: "2026-08-15T09:00:00.000Z",
      items: [{ provider: "chat_model", ok: false }],
    });
  });

  it("rejects a query the manifest does not declare", async () => {
    stubChat(() => Response.json({ items: [], pageInfo }));
    const result = await callAdminV2(chatSessionsRoute, {
      url: "/api/v2/admin/chat/sessions",
      actor: admin,
      query: { status: "mystery" },
    });
    expect(result.status).toBe(400);
  });
});
