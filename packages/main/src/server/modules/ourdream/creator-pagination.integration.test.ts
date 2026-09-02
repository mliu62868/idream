import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { api, createCharacter, createUser, expectError, expectOk, publishCharacterForPublicAudience } from "@/server/test/helpers";

const prefix = "zt-creator-pages-";
const ownerId = `${prefix}owner`;
const viewerId = `${prefix}viewer`;
const ids = Array.from({ length: 25 }, (_, i) => `${prefix}${String(i).padStart(2, "0")}`);

beforeAll(async () => {
  await createUser({ id: ownerId, dataClass: "customer", displayName: "Paged Creator" });
  await createUser({ id: viewerId, dataClass: "customer" });
  for (const id of [...ids, `${prefix}private`, `${prefix}paused`]) {
    await createCharacter({ id, creatorId: ownerId });
    await publishCharacterForPublicAudience({ characterId: id, ownerId });
    await prisma.character.update({ where: { id }, data: { createdAt: new Date("2026-01-01T00:00:00.000Z") } });
  }
  await prisma.character.update({ where: { id: `${prefix}private` }, data: { visibility: "private" } });
  await prisma.characterServing.update({ where: { characterId: `${prefix}paused` }, data: { state: "paused" } });
  await createCharacter({ id: `${prefix}unqualified`, creatorId: ownerId });
});

afterAll(async () => {
  // Immutable qualification evidence cannot be hard-deleted. Retire this
  // fixture from the public audience; isolated runners drop the whole database.
  await prisma.character.updateMany({ where: { creatorId: ownerId }, data: { visibility: "private", status: "archived" } });
  await prisma.user.updateMany({ where: { id: { in: [ownerId, viewerId] } }, data: { dataClass: "audit" } });
});

describe("creator public character pagination", () => {
  it("returns every qualified character once across tied dates and changing likes", async () => {
    const first = await api("GET", `creators/${ownerId}`, { ageGate: true });
    expectOk(first);
    expect(first.data.creator.stats.characters).toBe(25);
    expect(first.data.characters).toHaveLength(24);
    expect(first.data.nextCursor).toEqual(expect.any(String));
    await prisma.characterStats.update({ where: { characterId: ids[0]! }, data: { likesCount: 99 } });
    const last = await api("GET", `creators/${ownerId}`, { ageGate: true, query: { cursor: first.data.nextCursor } });
    expectOk(last);
    expect(last.data.characters).toHaveLength(1);
    expect(last.data.nextCursor).toBeNull();
    const allIds = [...first.data.characters, ...last.data.characters].map((item: { id: string }) => item.id);
    expect(allIds).toEqual([...ids].reverse());
    expect(new Set(allIds).size).toBe(25);
  });

  it("continues using row keys when the page size changes", async () => {
    const first = await api("GET", `creators/${ownerId}`, { ageGate: true, query: { limit: "7" } });
    expectOk(first);
    const last = await api("GET", `creators/${ownerId}`, { ageGate: true, query: { limit: "60", cursor: first.data.nextCursor } });
    expectOk(last);
    expect(last.data.characters).toHaveLength(18);
    expect(last.data.nextCursor).toBeNull();
    expect([...first.data.characters, ...last.data.characters].map((item: { id: string }) => item.id)).toEqual([...ids].reverse());
  });

  it("rejects stale viewer/filter scope and malformed cursors instead of silently restarting", async () => {
    const first = await api("GET", `creators/${ownerId}`, { ageGate: true, query: { limit: "1" } });
    const viewer = await api("GET", `creators/${ownerId}`, { ageGate: true, userId: viewerId, query: { cursor: first.data.nextCursor } });
    expectError(viewer, 400);
    const current = await api("GET", `creators/${ownerId}`, { ageGate: true, userId: viewerId, query: { limit: "1" } });
    await prisma.userPreferences.upsert({ where: { userId: viewerId }, create: { userId: viewerId, mutedTags: ["fantasy"], safeModeFlags: {}, notificationSettings: {} }, update: { mutedTags: ["fantasy"] } });
    const stale = await api("GET", `creators/${ownerId}`, { ageGate: true, userId: viewerId, query: { cursor: current.data.nextCursor } });
    expectError(stale, 400);
    const invalid = await api("GET", `creators/${ownerId}`, { ageGate: true, query: { cursor: "not-a-cursor" } });
    expectError(invalid, 400);
  });
});
