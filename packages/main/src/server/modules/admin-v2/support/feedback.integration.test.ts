import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { adminV2 } from "@/server/test/admin-v2-http";
import { api, createUser, expectError, expectOk, purgeTestData } from "@/server/test/helpers";

const prefix = "zt-feedback-ops-";
const adminId = `${prefix}admin`;
const customerId = `${prefix}customer`;
let itemId: string;

beforeAll(async () => {
  await createUser({ id: adminId, role: "admin", dataClass: "internal" });
  await createUser({ id: customerId, dataClass: "customer" });
  const created = await api("POST", "feedback/items", { userId: customerId, ageGate: true, body: {
    title: `${prefix}Remember the selected scene`, category: "improvement", description: "Keep my chosen scene after returning from a character conversation.",
  } });
  expectOk(created, 201);
  itemId = created.data.item.id;
});
afterAll(async () => { await purgeTestData(prefix); });

async function readItem() {
  const response = await adminV2("GET", "support/feedback", { userId: adminId, role: "admin", query: { search: prefix } });
  expectOk(response);
  return response.data.items.find((item: { id: string }) => item.id === itemId);
}

describe("product feedback operations", () => {
  it("moves a real customer idea through planned and shipped with private audit reasons", async () => {
    const before = await readItem();
    expect(before).toMatchObject({ status: "under_review", voteCount: 1 });
    const body = { status: "planned", expectedUpdatedAt: before.updatedAt, reason: "Accepted for the next product iteration" };
    const request = { userId: adminId, role: "admin", body, idempotencyKey: `${prefix}plan` };
    const updated = await adminV2("PATCH", `support/feedback/${itemId}`, request);
    expectOk(updated);
    expect(updated.data).toMatchObject({ item: { status: "planned", voteCount: 1 }, replayed: false });
    const replay = await adminV2("PATCH", `support/feedback/${itemId}`, request);
    expectOk(replay);
    expect(replay.data.replayed).toBe(true);
    expect(replay.data.item.updatedAt).toBe(updated.data.item.updatedAt);
    const collision = await adminV2("PATCH", `support/feedback/${itemId}`, { ...request, body: { ...body, status: "shipped" } });
    expectError(collision, 409);
    expect(await prisma.adminAuditLog.count({ where: { targetId: itemId, action: "support.feedback.update" } })).toBe(1);
    const visible = await api("GET", "feedback/items", { userId: customerId, ageGate: true });
    expectOk(visible);
    expect(visible.data.items.find((item: { id: string }) => item.id === itemId)).toMatchObject({ status: "planned", voteCount: 1 });
    expect(JSON.stringify(visible.data)).not.toContain(body.reason);
    const shipped = await adminV2("PATCH", `support/feedback/${itemId}`, {
      userId: adminId, role: "admin", idempotencyKey: `${prefix}ship`,
      body: { status: "shipped", expectedUpdatedAt: updated.data.item.updatedAt, reason: "Verified in the released user journey" },
    });
    expectOk(shipped);
    const after = await api("GET", "feedback/items", { userId: customerId, ageGate: true });
    expect(after.data.items.find((item: { id: string }) => item.id === itemId).status).toBe("shipped");
  });

  it("rejects a stale update after voting changes the item and keeps the new vote count", async () => {
    const before = await readItem();
    const voterId = `${prefix}voter`;
    await createUser({ id: voterId, dataClass: "customer" });
    expectOk(await api("POST", `feedback/items/${itemId}/vote`, { userId: voterId, ageGate: true }));
    const stale = await adminV2("PATCH", `support/feedback/${itemId}`, {
      userId: adminId, role: "admin", idempotencyKey: `${prefix}stale`,
      body: { status: "planned", expectedUpdatedAt: before.updatedAt, reason: "Stale operator snapshot" },
    });
    expectError(stale, 409);
    expect(await readItem()).toMatchObject({ status: "shipped", voteCount: 2 });
    expect(await prisma.controlPlaneCommand.count({ where: { idempotencyKey: `${prefix}stale` } })).toBe(0);
  });

  it("allows only one of two concurrent decisions against the same version", async () => {
    const before = await readItem();
    const results = await Promise.all(["planned", "under_review"].map((status) => adminV2("PATCH", `support/feedback/${itemId}`, {
      userId: adminId, role: "admin", idempotencyKey: `${prefix}race-${status}`,
      body: { status, expectedUpdatedAt: before.updatedAt, reason: "Concurrent product decision" },
    })));
    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
    expect(await prisma.adminAuditLog.count({ where: { targetId: itemId, action: "support.feedback.update" } })).toBe(3);
  });

  it("requires existing support permissions and paginates the complete filtered queue", async () => {
    expectError(await adminV2("GET", "support/feedback", { userId: customerId, role: "user" }), 403);
    const item = await readItem();
    expectError(await adminV2("PATCH", `support/feedback/${itemId}`, { userId: customerId, role: "user", body: { status: "shipped", expectedUpdatedAt: item.updatedAt, reason: "No operator permission" } }), 403);
    await prisma.productFeedbackItem.createMany({ data: Array.from({ length: 3 }, (_, index) => ({
      id: `${prefix}extra-${index}`, createdById: customerId, title: `${prefix}Additional ${index}`, description: "An additional customer feedback item.",
    })) });
    const first = await adminV2("GET", "support/feedback", { userId: adminId, role: "admin", query: { search: prefix, limit: 2 } });
    expectOk(first);
    expect(first.data.items).toHaveLength(2);
    const second = await adminV2("GET", "support/feedback", { userId: adminId, role: "admin", query: { search: prefix, limit: 2, cursor: first.data.pageInfo.endCursor } });
    expectOk(second);
    expect(second.data.items).toHaveLength(2);
    expect(new Set([...first.data.items, ...second.data.items].map((row: { id: string }) => row.id)).size).toBe(4);
    const mismatch = await adminV2("GET", "support/feedback", { userId: adminId, role: "admin", query: { status: "shipped", cursor: first.data.pageInfo.endCursor } });
    expectError(mismatch, 400);
  });
});
