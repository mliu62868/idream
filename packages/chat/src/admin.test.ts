import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { dispatchChatAdmin } from "./admin.js";
import { chatPrisma } from "./db.js";

const P = "zt-cadmin-";
const SECRET = "SUPER-SECRET-PLAINTEXT-CONTENT";
const AUTHORITY_USER = `${P}u1`;
const ORPHAN_USER = `${P}u2`;
const PAGINATION_USER = `${P}u3`;
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
  const periodStart = today();
  await chatPrisma.chatUsage.create({
    data: {
      id: `${P}usage1`,
      userId: AUTHORITY_USER,
      sessionId: `${P}s1`,
      messagesUsed: 29,
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
    const expected = await superPool.query<{
      active_sessions: number;
      messages_24h: number;
      moderation_events_24h: number;
      messages_used_today: number;
    }>(
      `SELECT
        (
          SELECT count(*)::int
          FROM chat.chat_sessions s
          JOIN core.chat_user_view u ON u.user_id = s.user_id
          WHERE u.status = 'active'
            AND u.deleted_at IS NULL
            AND s.status = 'active'
            AND s.deleted_at IS NULL
        ) AS active_sessions,
        (
          SELECT count(*)::int
          FROM chat.messages m
          JOIN chat.chat_sessions s ON s.id = m.session_id
          JOIN core.chat_user_view u ON u.user_id = s.user_id
          WHERE u.status = 'active'
            AND u.deleted_at IS NULL
            AND m.created_at >= now() - interval '24 hours'
        ) AS messages_24h,
        (
          SELECT count(*)::int
          FROM chat.chat_moderation_events e
          JOIN chat.messages m ON e.target_type = 'message' AND m.id = e.target_id
          JOIN chat.chat_sessions s ON s.id = m.session_id
          JOIN core.chat_user_view u ON u.user_id = s.user_id
          WHERE u.status = 'active'
            AND u.deleted_at IS NULL
            AND e.created_at >= now() - interval '24 hours'
        ) AS moderation_events_24h,
        (
          SELECT COALESCE(sum(cu.messages_used), 0)::int
          FROM chat.chat_usage cu
          JOIN core.chat_user_view u ON u.user_id = cu.user_id
          WHERE u.status = 'active'
            AND u.deleted_at IS NULL
            AND cu.period_start = date_trunc('day', now() AT TIME ZONE 'UTC')
        ) AS messages_used_today`,
    );
    const scoped = expected.rows[0]!;

    expect(body.activeSessions).toBe(scoped.active_sessions);
    expect(body.messages24h).toBe(scoped.messages_24h);
    expect(body.moderationEvents24h).toBe(scoped.moderation_events_24h);
    expect(body.messagesUsedToday).toBe(scoped.messages_used_today);
    expect(body.dataScope).toMatchObject({
      userAuthority: "core.chat_user_view",
      includedUserStatus: "active",
      includedDeletedAt: null,
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
    expect(body.freeDailyLimit).toBe(30);
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.messagesUsed).toBe(29);
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
