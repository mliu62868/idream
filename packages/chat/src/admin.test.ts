import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dispatchChatAdmin } from "./admin.js";
import { chatPrisma } from "./db.js";

const P = "zt-cadmin-";
const SECRET = "SUPER-SECRET-PLAINTEXT-CONTENT";

async function purge() {
  await chatPrisma.chatModerationEvent.deleteMany({ where: { id: { startsWith: P } } });
  await chatPrisma.chatUsage.deleteMany({ where: { id: { startsWith: P } } });
  await chatPrisma.message.deleteMany({ where: { id: { startsWith: P } } });
  await chatPrisma.chatSession.deleteMany({ where: { id: { startsWith: P } } });
}

function today() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

beforeAll(async () => {
  await purge();
  await chatPrisma.chatSession.create({
    data: {
      id: `${P}s1`,
      userId: `${P}u1`,
      characterId: `${P}c1`,
      status: "active",
      lastMessageAt: new Date(),
    },
  });
  await chatPrisma.chatSession.create({
    data: { id: `${P}s2`, userId: `${P}u1`, characterId: `${P}c2`, status: "archived" },
  });
  await chatPrisma.message.create({
    data: {
      id: `${P}m1`,
      sessionId: `${P}s1`,
      role: "user",
      content: SECRET,
      status: "sent",
      safetyStatus: "ok",
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
    },
  });
  const periodStart = today();
  await chatPrisma.chatUsage.create({
    data: {
      id: `${P}usage1`,
      userId: `${P}u1`,
      sessionId: `${P}s1`,
      messagesUsed: 29,
      periodStart,
      periodEnd: new Date(periodStart.getTime() + 24 * 60 * 60 * 1000),
    },
  });
});

afterAll(async () => {
  await purge();
});

describe("chat internal admin api", () => {
  it("routing: rejects non-GET (405), unknown path (404), foreign prefix (404)", async () => {
    expect((await dispatchChatAdmin({ method: "POST", path: "/internal/admin/overview" })).status).toBe(405);
    expect((await dispatchChatAdmin({ method: "GET", path: "/internal/admin/nope" })).status).toBe(404);
    expect((await dispatchChatAdmin({ method: "GET", path: "/api/v1/chat/sessions" })).status).toBe(404);
  });

  it("overview returns aggregate counts", async () => {
    const res = await dispatchChatAdmin({ method: "GET", path: "/internal/admin/overview" });
    expect(res.status).toBe(200);
    const body = res.body as Record<string, number>;
    expect(body.activeSessions).toBeGreaterThanOrEqual(1);
    expect(body.archivedSessions).toBeGreaterThanOrEqual(1);
    expect(body.messages24h).toBeGreaterThanOrEqual(1);
    expect(body.moderationEvents24h).toBeGreaterThanOrEqual(1);
  });

  it("provider health returns redacted chat provider metadata", async () => {
    const res = await dispatchChatAdmin({ method: "GET", path: "/internal/admin/provider-health" });
    expect(res.status).toBe(200);
    const body = res.body as { items: Array<Record<string, unknown>> };
    expect(body.items.some((item) => item.provider === "chat_model")).toBe(true);
    expect(body.items.some((item) => item.provider === "chat_moderation")).toBe(true);
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

  it("moderation events omit raw details (no plaintext leak)", async () => {
    const res = await dispatchChatAdmin({
      method: "GET",
      path: "/internal/admin/moderation-events",
      query: { limit: "10", status: "blocked", layer: "input" },
    });
    expect(res.status).toBe(200);
    const body = res.body as { items: Array<Record<string, unknown>> };
    expect(body.items.some((e) => e.id === `${P}e1`)).toBe(true);
    expect(JSON.stringify(body)).not.toContain(SECRET);
  });
});
