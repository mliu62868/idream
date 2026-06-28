import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dispatchChatAdmin } from "./admin.js";
import { chatPrisma } from "./db.js";

const P = "zt-cadmin-";
const SECRET = "SUPER-SECRET-PLAINTEXT-CONTENT";

async function purge() {
  await chatPrisma.chatModerationEvent.deleteMany({ where: { id: { startsWith: P } } });
  await chatPrisma.message.deleteMany({ where: { id: { startsWith: P } } });
  await chatPrisma.chatSession.deleteMany({ where: { id: { startsWith: P } } });
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

  it("sessions are metadata-only (no plaintext content) and filter by user", async () => {
    const res = await dispatchChatAdmin({
      method: "GET",
      path: "/internal/admin/sessions",
      query: { userId: `${P}u1` },
    });
    expect(res.status).toBe(200);
    const body = res.body as { items: Array<Record<string, unknown>> };
    expect(body.items).toHaveLength(2);
    const s1 = body.items.find((s) => s.id === `${P}s1`);
    expect(s1?.messageCount).toBe(1);
    // Never leak message plaintext through the ops surface.
    expect(JSON.stringify(body)).not.toContain(SECRET);
  });

  it("moderation events omit raw details (no plaintext leak)", async () => {
    const res = await dispatchChatAdmin({
      method: "GET",
      path: "/internal/admin/moderation-events",
      query: { limit: "10" },
    });
    expect(res.status).toBe(200);
    const body = res.body as { items: Array<Record<string, unknown>> };
    expect(body.items.some((e) => e.id === `${P}e1`)).toBe(true);
    expect(JSON.stringify(body)).not.toContain(SECRET);
  });
});
