import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { api, createUser, expectError, expectOk, purgeTestData } from "@/server/test/helpers";

const prefix = "zt-feedback-pages-";
const customerId = `${prefix}customer`;
const otherId = `${prefix}other`;
const internalId = `${prefix}internal`;
const ids = Array.from({ length: 25 }, (_, index) => `${prefix}${String(index).padStart(2, "0")}`);

beforeAll(async () => {
  await createUser({ id: customerId, dataClass: "customer" });
  await createUser({ id: otherId, dataClass: "customer" });
  await createUser({ id: internalId, dataClass: "internal" });
  await prisma.productFeedbackItem.createMany({ data: ids.map((id) => ({
    id, createdById: customerId, source: "user", title: id, description: "A customer product suggestion.",
    status: "planned", createdAt: new Date("2030-01-01T00:00:00.000Z"),
  })) });
  await prisma.productFeedbackItem.createMany({ data: [
    { id: `${prefix}private`, createdById: customerId, visibility: "unlisted", status: "planned" },
    { id: `${prefix}internal-item`, createdById: internalId, status: "planned" },
    { id: `${prefix}shipped`, createdById: customerId, status: "shipped" },
  ].map((row) => ({ ...row, source: "user", title: row.id, description: "Not part of the planned public page.", createdAt: new Date("2030-01-02T00:00:00.000Z") })) });
});
afterAll(() => purgeTestData(prefix));

describe("public roadmap pagination", () => {
  it("continues beyond twelve items without duplicates or omissions after votes change", async () => {
    const first = await api("GET", "feedback/items", { userId: customerId, query: { status: "planned" } });
    expectOk(first);
    expect(first.data.items.map((item: { id: string }) => item.id)).toEqual([...ids].reverse().slice(0, 12));
    expect(first.data.nextCursor).toEqual(expect.any(String));
    expect(first.data.viewerId).toBe(customerId);
    expectOk(await api("POST", `feedback/items/${ids[0]}/vote`, { userId: customerId, ageGate: true }));
    const second = await api("GET", "feedback/items", { userId: customerId, query: { status: "planned", cursor: first.data.nextCursor, limit: "60" } });
    expectOk(second);
    const all = [...first.data.items, ...second.data.items].filter((item: { id: string }) => ids.includes(item.id));
    expect(all.map((item: { id: string }) => item.id)).toEqual([...ids].reverse());
    expect(new Set(all.map((item: { id: string }) => item.id)).size).toBe(25);
    expect(second.data.items.find((item: { id: string }) => item.id === ids[0])).toMatchObject({ voteCount: 1, userVoted: true });
    expect(second.data.nextCursor).toBeNull();
    expect(second.data.items.some((item: { id: string }) => item.id === `${prefix}private` || item.id === `${prefix}internal-item`)).toBe(false);
  });

  it("keeps status and viewer cursors scoped and refreshes current public state", async () => {
    const first = await api("GET", "feedback/items", { userId: customerId, query: { status: "planned", limit: "1" } });
    expectError(await api("GET", "feedback/items", { userId: customerId, query: { status: "shipped", cursor: first.data.nextCursor } }), 400);
    expectError(await api("GET", "feedback/items", { userId: otherId, query: { status: "planned", cursor: first.data.nextCursor } }), 400);
    await prisma.productFeedbackItem.update({ where: { id: ids[24] }, data: { status: "shipped" } });
    const refreshed = await api("GET", "feedback/items", { userId: customerId, query: { status: "planned", limit: "60" } });
    expectOk(refreshed);
    expect(refreshed.data.items.some((item: { id: string }) => item.id === ids[24])).toBe(false);
    const shipped = await api("GET", "feedback/items", { userId: otherId, query: { status: "shipped" } });
    expectOk(shipped);
    expect(shipped.data.items.every((item: { status: string }) => item.status === "shipped")).toBe(true);
    expect(shipped.data.items.some((item: { id: string }) => item.id === ids[24])).toBe(true);
    const other = await api("GET", "feedback/items", { userId: otherId, query: { status: "planned", limit: "60" } });
    expect(other.data.viewerId).toBe(otherId);
    expect(other.data.items.find((item: { id: string }) => item.id === ids[0])).toMatchObject({ userVoted: false });
  });

  it("rejects malformed cursors and unknown filters without silently restarting", async () => {
    expectError(await api("GET", "feedback/items", { query: { cursor: "not-a-cursor" } }), 400);
    expectError(await api("GET", "feedback/items", { query: { status: "missing" } }), 400);
  });
});
