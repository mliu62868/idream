import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET } from "@/app/api/v2/admin/chat/engagement/route";
import { prisma } from "@/server/lib/db";
import { callAdminV2 } from "@/server/test/admin-v2-client";
import { createCharacter, createUser, purgeTestData } from "@/server/test/helpers";
const P = "zt-chat-engagement-";
const actor = { userId: `${P}admin`, role: "admin" };
function get(kind: string, extra: Record<string, string> = {}, caller = actor) {
  return callAdminV2(GET, { url: "/api/v2/admin/chat/engagement", actor: caller, query: { kind, ...extra } });
}
beforeAll(async () => {
  await purgeTestData(P);
  await createUser({ id: actor.userId, role: "admin" });
  await createUser({ id: `${P}analyst`, role: "analyst" });
  for (const dataClass of ["customer", "fixture"] as const) {
    const userId = `${P}${dataClass}`;
    await createUser({ id: userId, dataClass });
    await createCharacter({ id: `${P}character-${dataClass}`, creatorId: userId });
    await prisma.groupConversation.create({ data: { id: `${P}group-${dataClass}`, userId, title: "PRIVATE GROUP TITLE" } });
    for (const suffix of ["due", "missing", "disabled"]) {
      const sessionId = `${P}${dataClass}-${suffix}`;
      await prisma.recentChat.create({ data: { sessionId, userId, characterId: `${P}character-${dataClass}`, groupId: suffix === "due" ? `${P}group-${dataClass}` : null, groupPosition: suffix === "due" ? 0 : null, proactiveEnabled: suffix !== "disabled", proactiveNextAt: suffix === "due" ? new Date(0) : null } });
      if (suffix === "due" || suffix === "disabled") {
        const turnId = `${sessionId}-turn`;
        await prisma.chatTurn.create({ data: { id: turnId, sessionId, idempotencyKey: turnId, requestHash: turnId, userMessageId: `${turnId}-user`, assistantMessageId: `${turnId}-assistant`, userContent: "PRIVATE USER TEXT", assistantContent: "PRIVATE REPLY", assistantStatus: "failed", origin: "proactive", memoryEnabled: true, admissionAttempts: 2, admissionLastError: { message: "PRIVATE ERROR" } } });
        if (suffix === "due") await prisma.groupChatTurn.create({ data: { groupId: `${P}group-${dataClass}`, ordinal: 1, turnId } });
      }
    }
  }
});
afterAll(async () => { await purgeTestData(P); await prisma.$disconnect(); });
describe("Chat engagement operations", () => {
  it("enforces read permissions and requires an explicit operation kind", async () => {
    expect((await get("groups", {}, { userId: `${P}analyst`, role: "analyst" })).status).toBe(403);
    expect((await get("unknown")).status).toBe(400);
  });
  it("returns customer group membership and failed Turn evidence without plaintext", async () => {
    const result = await get("groups");
    expect(result.status).toBe(200);
    expect(result.data.items).toHaveLength(1);
    expect(result.data.items[0]).toMatchObject({ id: `${P}group-customer`, sessions: [{ sessionId: `${P}customer-due` }], latestTurn: { status: "failed", admissionAttempts: 2, hasAdmissionError: true, admissionNextRunAt: null } });
    expect(JSON.stringify(result.data)).not.toContain("PRIVATE");
    expect((await get("groups", { userId: `${P}fixture` })).data.items).toEqual([]);
  });
  it("distinguishes due, missing schedule, and disabled history; binds paging to filters", async () => {
    const result = await get("proactive", { userId: `${P}customer` });
    expect(result.status).toBe(200);
    expect(result.data.items.map((row: { schedule: { state: string } }) => row.schedule.state).sort()).toEqual(["disabled", "due", "missing_schedule"]);
    expect(JSON.stringify(result.data)).not.toContain("PRIVATE");
    const first = await get("proactive", { userId: `${P}customer`, limit: "1" });
    expect(first.data.pageInfo.hasNextPage).toBe(true);
    const second = await get("proactive", { userId: `${P}customer`, limit: "1", cursor: first.data.pageInfo.endCursor });
    expect(second.status).toBe(200);
    expect(second.data.items[0].id).not.toBe(first.data.items[0].id);
    expect((await get("proactive", { userId: `${P}fixture`, cursor: first.data.pageInfo.endCursor })).status).toBe(400);
  });
});
