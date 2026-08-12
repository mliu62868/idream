import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FREE_DAILY_MESSAGES } from "@idream/shared/chat/limits";
import { Pool } from "pg";
import { dispatchChatAdmin } from "./admin.js";
import { chatPrisma } from "./db.js";

const P = "zt-cadmin-";
const SECRET = "SUPER-SECRET-PLAINTEXT-CONTENT";
const AUTHORITY_USER = `${P}u1`;
const ORPHAN_USER = `${P}u2`;
const PAGINATION_USER = `${P}u3`;
const AUDIT_USER = `${P}audit`;
const superPool = new Pool({ connectionString: process.env.CHAT_TEST_SUPER_URL });

async function purge() {
  await chatPrisma.chatModerationEvent.deleteMany({ where: { id: { startsWith: P } } });
  await chatPrisma.chatUsage.deleteMany({ where: { id: { startsWith: P } } });
  await chatPrisma.message.deleteMany({ where: { id: { startsWith: P } } });
  await chatPrisma.chatSession.deleteMany({ where: { id: { startsWith: P } } });
  await superPool.query(`DELETE FROM public.users WHERE id LIKE $1`, [`${P}%`]);
}

function today() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

beforeAll(async () => {
  await purge();
  await superPool.query(
    `INSERT INTO public.users (id,email,status,"createdAt","updatedAt")
     VALUES
       ($1,$2,'active',now(),now()),
       ($3,$4,'active',now(),now())`,
    [
      AUTHORITY_USER,
      `${AUTHORITY_USER}@chat-admin.test`,
      PAGINATION_USER,
      `${PAGINATION_USER}@chat-admin.test`,
    ],
  );
  await superPool.query(
    `INSERT INTO public.users
       (id,email,status,"dataClass","createdAt","updatedAt")
     VALUES ($1,$2,'active','audit',now(),now())`,
    [AUDIT_USER, `${AUDIT_USER}@chat-admin.test`],
  );
  await chatPrisma.chatSession.create({
    data: {
      id: `${P}s1`,
      userId: AUTHORITY_USER,
      characterId: `${P}c1`,
      status: "active",
      lastMessageAt: new Date("2099-01-01T00:00:00.000Z"),
    },
  });
  await chatPrisma.chatSession.create({
    data: {
      id: `${P}s-audit`,
      userId: AUDIT_USER,
      characterId: `${P}c-audit`,
      status: "active",
      lastMessageAt: new Date("2101-01-01T00:00:00.000Z"),
    },
  });
  await chatPrisma.chatSession.create({
    data: { id: `${P}s2`, userId: AUTHORITY_USER, characterId: `${P}c2`, status: "archived" },
  });
  await chatPrisma.chatSession.create({
    data: {
      id: `${P}s-orphan`,
      userId: ORPHAN_USER,
      characterId: `${P}c-orphan`,
      status: "active",
      lastMessageAt: new Date("2100-01-01T00:00:00.000Z"),
    },
  });
  await chatPrisma.message.create({
    data: {
      id: `${P}m1`,
      sessionId: `${P}s1`,
      role: "user",
      content: SECRET,
      status: "sent",
      safetyStatus: "ok",
      createdAt: new Date("2099-01-01T00:00:00.000Z"),
    },
  });
  await chatPrisma.message.create({
    data: {
      id: `${P}m-audit`,
      sessionId: `${P}s-audit`,
      role: "user",
      content: "audit probe",
      status: "sent",
      safetyStatus: "ok",
      createdAt: new Date("2101-01-01T00:00:00.000Z"),
    },
  });
  await chatPrisma.message.create({
    data: {
      id: `${P}m-orphan`,
      sessionId: `${P}s-orphan`,
      role: "user",
      content: "orphan fixture",
      status: "sent",
      safetyStatus: "ok",
      createdAt: new Date("2100-01-01T00:00:00.000Z"),
    },
  });
  await chatPrisma.chatModerationEvent.create({
    data: {
      id: `${P}e1`,
      targetType: "message",
      targetId: `${P}m1`,
      layer: "input",
      status: "blocked",
      policyCode: "test_policy",
      confidence: 0.9,
      details: { note: SECRET },
      createdAt: new Date("2099-01-03T00:00:00.000Z"),
    },
  });
  await chatPrisma.chatModerationEvent.create({
    data: {
      id: `${P}e3`,
      targetType: "message",
      targetId: `${P}m1`,
      layer: "input",
      status: "blocked",
      policyCode: "test_policy",
      confidence: 0.8,
      details: {},
      createdAt: new Date("2099-01-02T00:00:00.000Z"),
    },
  });
  await chatPrisma.chatModerationEvent.createMany({
    data: Array.from({ length: 120 }, (_, index) => ({
      id: `${P}e-orphan-${index.toString().padStart(3, "0")}`,
      targetType: "message",
      targetId: `${P}m-orphan`,
      layer: "input",
      status: "blocked",
      policyCode: "test_policy",
      confidence: 0.7,
      details: {},
      createdAt: new Date("2100-01-01T00:00:00.000Z"),
    })),
  });
  await chatPrisma.chatModerationEvent.create({
    data: {
      id: `${P}e-audit`,
      targetType: "message",
      targetId: `${P}m-audit`,
      layer: "input",
      status: "blocked",
      policyCode: "audit_probe",
      confidence: 1,
      details: {},
      createdAt: new Date("2101-01-01T00:00:00.000Z"),
    },
  });
  const periodStart = today();
  await chatPrisma.chatUsage.create({
    data: {
      id: `${P}usage1`,
      userId: AUTHORITY_USER,
      sessionId: `${P}s1`,
      messagesUsed: FREE_DAILY_MESSAGES - 1,
      periodStart,
      periodEnd: new Date(periodStart.getTime() + 24 * 60 * 60 * 1000),
    },
  });
  await chatPrisma.chatUsage.create({
    data: {
      id: `${P}usage-audit`,
      userId: AUDIT_USER,
      sessionId: `${P}s-audit`,
      messagesUsed: 999_999,
      periodStart,
      periodEnd: new Date(periodStart.getTime() + 24 * 60 * 60 * 1000),
    },
  });
  await chatPrisma.chatUsage.create({
    data: {
      id: `${P}usage2`,
      userId: ORPHAN_USER,
      sessionId: null,
      messagesUsed: 1_000_000,
      periodStart,
      periodEnd: new Date(periodStart.getTime() + 24 * 60 * 60 * 1000),
    },
  });
  await chatPrisma.chatUsage.create({
    data: {
      id: `${P}usage3`,
      userId: PAGINATION_USER,
      sessionId: null,
      messagesUsed: 1,
      periodStart,
      periodEnd: new Date(periodStart.getTime() + 24 * 60 * 60 * 1000),
    },
  });
});

afterAll(async () => {
  await purge();
  await superPool.end();
});

describe("chat internal admin api", () => {
  it("routing: rejects non-GET (405), unknown path (404), foreign prefix (404)", async () => {
    expect((await dispatchChatAdmin({ method: "POST", path: "/internal/admin/overview" })).status).toBe(405);
    expect((await dispatchChatAdmin({ method: "GET", path: "/internal/admin/nope" })).status).toBe(404);
    expect((await dispatchChatAdmin({ method: "GET", path: "/api/v1/chat/sessions" })).status).toBe(404);
  });

  it("overview scopes operational metrics to active authoritative users", async () => {
    const res = await dispatchChatAdmin({ method: "GET", path: "/internal/admin/overview" });
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    // The package suites intentionally share the provisioned Chat authority
    // database, so global totals can change while this request is in flight.
    // Assert the deterministic lower bounds contributed by this test's unique
    // prefix; the exclusion counters below prove the opposite scope boundary.
    expect(body.activeSessions).toEqual(expect.any(Number));
    expect(body.activeSessions as number).toBeGreaterThanOrEqual(1);
    expect(body.messages24h).toEqual(expect.any(Number));
    expect(body.messages24h as number).toBeGreaterThanOrEqual(1);
    expect(body.moderationEvents24h).toEqual(expect.any(Number));
    expect(body.moderationEvents24h as number).toBeGreaterThanOrEqual(2);
    expect(body.messagesUsedToday).toEqual(expect.any(Number));
    expect(body.messagesUsedToday as number).toBeGreaterThanOrEqual(FREE_DAILY_MESSAGES - 1);
    expect(body.dataScope).toMatchObject({
      userAuthority: "core.chat_user_view",
      includedUserStatus: "active",
      includedDeletedAt: null,
      includedDataClass: "customer",
      excluded: {
        activeSessions: expect.any(Number),
        messages24h: expect.any(Number),
        moderationEvents24h: expect.any(Number),
        usageRowsToday: expect.any(Number),
        messagesUsedToday: expect.any(Number),
      },
    });
    const dataScope = body.dataScope as {
      excluded: Record<string, number>;
    };
    expect(dataScope.excluded.activeSessions).toBeGreaterThanOrEqual(1);
    expect(dataScope.excluded.messages24h).toBeGreaterThanOrEqual(1);
    expect(dataScope.excluded.moderationEvents24h).toBeGreaterThanOrEqual(120);
    expect(dataScope.excluded.usageRowsToday).toBeGreaterThanOrEqual(1);
    expect(dataScope.excluded.messagesUsedToday).toBeGreaterThanOrEqual(1_000_000);
  });

  it("provider health returns redacted chat provider metadata", async () => {
    const res = await dispatchChatAdmin({ method: "GET", path: "/internal/admin/provider-health" });
    expect(res.status).toBe(200);
    const body = res.body as { items: Array<Record<string, unknown>> };
    expect(body.items.some((item) => item.provider === "chat_model")).toBe(true);
    expect(body.items.some((item) => item.provider === "chat_moderation")).toBe(true);
    expect(body.items.find((item) => item.provider === "chat_model")).toMatchObject({
      adapter: "mock",
      latencyMs: null,
    });
    expect(JSON.stringify(body)).not.toContain("API_KEY");
    expect(JSON.stringify(body)).not.toContain(SECRET);
  });

  it("sessions are metadata-only (no plaintext content) and filter by user", async () => {
    const res = await dispatchChatAdmin({
      method: "GET",
      path: "/internal/admin/sessions",
      query: { userId: `${P}u1`, status: "active" },
    });
    expect(res.status).toBe(200);
    const body = res.body as { items: Array<Record<string, unknown>> };
    expect(body.items).toHaveLength(1);
    const s1 = body.items.find((s) => s.id === `${P}s1`);
    expect(s1?.messageCount).toBe(1);
    expect(s1?.lastMessageStatus).toBe("sent");
    // Never leak message plaintext through the ops surface.
    expect(JSON.stringify(body)).not.toContain(SECRET);
  });

  it("sessions apply authoritative user scope before the page limit", async () => {
    const res = await dispatchChatAdmin({
      method: "GET",
      path: "/internal/admin/sessions",
      query: { limit: "1", status: "active" },
    });
    expect(res.status).toBe(200);
    const body = res.body as { items: Array<{ id: string; userId: string }> };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ id: `${P}s1`, userId: AUTHORITY_USER });

    const orphan = await dispatchChatAdmin({
      method: "GET",
      path: "/internal/admin/sessions",
      query: { userId: ORPHAN_USER, status: "active" },
    });
    expect(orphan.body).toMatchObject({ items: [] });
    const audit = await dispatchChatAdmin({
      method: "GET",
      path: "/internal/admin/sessions",
      query: { userId: AUDIT_USER, status: "active" },
    });
    expect(audit.body).toMatchObject({ items: [] });
  });

  it("rejects malformed or unknown canonical list query parameters", async () => {
    await expect(dispatchChatAdmin({ method: "GET", path: "/internal/admin/sessions", query: { limit: "1junk" } })).resolves.toMatchObject({ status: 400 });
    await expect(dispatchChatAdmin({ method: "GET", path: "/internal/admin/sessions", query: { status: "mystery" } })).resolves.toMatchObject({ status: 400 });
    await expect(dispatchChatAdmin({ method: "GET", path: "/internal/admin/usage", query: { ignored: "value" } })).resolves.toMatchObject({ status: 400 });
  });

  it("usage returns current daily quota metadata", async () => {
    const res = await dispatchChatAdmin({
      method: "GET",
      path: "/internal/admin/usage",
      query: { userId: `${P}u1`, limit: "10" },
    });
    expect(res.status).toBe(200);
    const body = res.body as { items: Array<Record<string, unknown>>; freeDailyLimit: number };
    expect(body.freeDailyLimit).toBe(FREE_DAILY_MESSAGES);
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.messagesUsed).toBe(FREE_DAILY_MESSAGES - 1);
    expect(body.items[0]?.freeRemaining).toBe(1);
    expect(body.items[0]?.quotaStatus).toBe("free_remaining");
    expect(JSON.stringify(body)).not.toContain(SECRET);
  });

  it("usage applies authoritative user scope before the page limit", async () => {
    const res = await dispatchChatAdmin({
      method: "GET",
      path: "/internal/admin/usage",
      query: { limit: "1" },
    });
    expect(res.status).toBe(200);
    const body = res.body as { items: Array<{ userId: string }> };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.userId).not.toBe(ORPHAN_USER);
    const returnedUser = await chatPrisma.chatUserView.findUnique({
      where: { userId: body.items[0]!.userId },
    });
    expect(returnedUser).toMatchObject({ status: "active", deletedAt: null });

    const orphan = await dispatchChatAdmin({
      method: "GET",
      path: "/internal/admin/usage",
      query: { userId: ORPHAN_USER },
    });
    expect(orphan.body).toMatchObject({ items: [] });
    const audit = await dispatchChatAdmin({
      method: "GET",
      path: "/internal/admin/usage",
      query: { userId: AUDIT_USER },
    });
    expect(audit.body).toMatchObject({ items: [] });
  });

  it("requires authority users to remain active and not deleted", async () => {
    try {
      await superPool.query(
        `UPDATE public.users SET status = 'suspended', "updatedAt" = now() WHERE id = $1`,
        [PAGINATION_USER],
      );
      const suspended = await dispatchChatAdmin({
        method: "GET",
        path: "/internal/admin/usage",
        query: { userId: PAGINATION_USER },
      });
      expect(suspended.body).toMatchObject({ items: [] });

      await superPool.query(
        `UPDATE public.users
         SET status = 'active', "deletedAt" = now(), "updatedAt" = now()
         WHERE id = $1`,
        [PAGINATION_USER],
      );
      const deleted = await dispatchChatAdmin({
        method: "GET",
        path: "/internal/admin/usage",
        query: { userId: PAGINATION_USER },
      });
      expect(deleted.body).toMatchObject({ items: [] });
    } finally {
      await superPool.query(
        `UPDATE public.users
         SET status = 'active', "deletedAt" = NULL, "updatedAt" = now()
         WHERE id = $1`,
        [PAGINATION_USER],
      );
    }
  });

  it("moderation events omit raw details (no plaintext leak)", async () => {
    const res = await dispatchChatAdmin({
      method: "GET",
      path: "/internal/admin/moderation-events",
      query: { limit: "10", status: "blocked", layer: "input" },
    });
    expect(res.status).toBe(200);
    const body = res.body as { items: Array<Record<string, unknown>> };
    expect(body.items.some((e) => e.id === `${P}e1`)).toBe(true);
    expect(body.items.some((e) => String(e.id).includes("e-orphan"))).toBe(false);
    expect(JSON.stringify(body)).not.toContain(SECRET);
  });

  it("keeps excluded legacy chat rows intact", async () => {
    expect(
      await chatPrisma.chatSession.count({ where: { userId: ORPHAN_USER } }),
    ).toBe(1);
    expect(
      await chatPrisma.chatUsage.count({ where: { userId: ORPHAN_USER } }),
    ).toBe(1);
    expect(
      await chatPrisma.chatModerationEvent.count({
        where: { targetId: `${P}m-orphan` },
      }),
    ).toBe(120);
  });

  const cursorCases: Array<{ path: string; query: Record<string, string> }> = [
    { path: "/internal/admin/sessions", query: { userId: `${P}u1`, status: "all" } },
    { path: "/internal/admin/usage", query: {} },
    {
      path: "/internal/admin/moderation-events",
      query: {
        status: "blocked",
        layer: "input",
        policyCode: "test_policy",
        targetId: `${P}m1`,
      },
    },
  ];
  for (const testCase of cursorCases) {
    it(`${testCase.path} exposes a deterministic query-bound cursor`, async () => {
      const first = await dispatchChatAdmin({
        method: "GET",
        path: testCase.path,
        query: { ...testCase.query, limit: "1" },
      });
      expect(first.status).toBe(200);
      const firstBody = first.body as {
        items: Array<{ id?: string; userId?: string }>;
        pageInfo: { endCursor: string | null; hasNextPage: boolean };
      };
      expect(firstBody.items).toHaveLength(1);
      expect(firstBody.pageInfo).toMatchObject({ hasNextPage: true, endCursor: expect.any(String) });

      if (testCase.path === "/internal/admin/moderation-events") {
        await chatPrisma.chatModerationEvent.delete({ where: { id: firstBody.items[0]!.id! } });
      }

      const second = await dispatchChatAdmin({
        method: "GET",
        path: testCase.path,
        query: { ...testCase.query, limit: "1", cursor: firstBody.pageInfo.endCursor ?? "" },
      });
      expect(second.status).toBe(200);
      const secondBody = second.body as typeof firstBody;
      expect(secondBody.items).toHaveLength(1);
      expect(secondBody.items[0]?.id ?? secondBody.items[0]?.userId).not.toBe(
        firstBody.items[0]?.id ?? firstBody.items[0]?.userId,
      );

      const mismatch = await dispatchChatAdmin({
        method: "GET",
        path: testCase.path,
        query: {
          ...testCase.query,
          limit: "1",
          cursor: firstBody.pageInfo.endCursor ?? "",
          ...(testCase.path === "/internal/admin/moderation-events"
            ? { targetId: "different" }
            : { userId: "different" }),
        },
      });
      expect(mismatch.status).toBe(400);
    });
  }
});
