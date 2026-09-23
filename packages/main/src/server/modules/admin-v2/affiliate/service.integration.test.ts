import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { adminV2 } from "@/server/test/admin-v2-http";
import { api, createUser, expectError, expectOk, purgeTestData } from "@/server/test/helpers";

const prefix = "zt-affiliate-ops-";
const adminId = `${prefix}admin`;
const supportId = `${prefix}support`;
const customerId = `${prefix}customer`;
const termsPublishedAt = new Date("2026-09-01T00:00:00Z");
// Applications are accepted only against the published /affiliate terms page.
const application = { termsVersion: termsPublishedAt.toISOString(), channels: ["https://example.test/channel"] };
let itemId: string;

beforeAll(async () => {
  await prisma.routePage.create({ data: {
    path: "/affiliate", template: "article", title: `${prefix}Affiliate program`,
    description: "Program terms for creators who promote iDream to adult audiences.",
    contentStatus: "published", contentSchemaVersion: 1, indexingStatus: "noindex", canonical: null,
    publishedAt: termsPublishedAt,
    body: {
      heading: "Affiliate program",
      intro: "These are the terms that apply to every approved affiliate partner of iDream.",
      sections: [
        { heading: "Attribution", paragraphs: ["A signup counts when it follows your link within the attribution window."] },
        { heading: "Payouts", paragraphs: ["Commission and settlement terms are published separately before any payout."] },
      ],
    },
  } });
  await createUser({ id: adminId, role: "admin", dataClass: "internal" });
  await createUser({ id: supportId, role: "support", dataClass: "internal" });
  await createUser({ id: customerId, dataClass: "customer" });
  const created = await api("POST", "affiliate/application", { userId: customerId, body: application });
  expectOk(created, 201);
  itemId = created.data.id;
});
afterAll(async () => {
  await prisma.routePage.deleteMany({ where: { path: "/affiliate", title: { startsWith: prefix } } });
  await purgeTestData(prefix);
});

async function readItem() {
  const result = await adminV2("GET", "affiliate/applications", { userId: adminId, role: "admin", query: { status: "all", search: customerId } });
  expectOk(result);
  return result.data.items.find((item: { id: string }) => item.id === itemId);
}
const decide = (key: string, body: Record<string, unknown>) => adminV2("POST", `affiliate/applications/${itemId}/decision`, {
  userId: adminId, role: "admin", idempotencyKey: `${prefix}${key}`, body,
});

describe("affiliate operational approval", () => {
  it("enforces read/write permission and typed confirmation before any decision", async () => {
    expectError(await adminV2("GET", "affiliate/applications", {}), 401);
    expectError(await adminV2("GET", "affiliate/applications", { userId: customerId, role: "user" }), 403);
    expectOk(await adminV2("GET", "affiliate/applications", { userId: supportId, role: "support" }));
    const item = await readItem();
    const body = { status: "approved", reason: "Reviewed promotion channels", confirmation: itemId, expectedUpdatedAt: item.updatedAt };
    expectError(await adminV2("POST", `affiliate/applications/${itemId}/decision`, { userId: supportId, role: "support", body }), 403);
    expectError(await decide("wrong-confirm", { ...body, confirmation: "wrong" }), 400);
    expect(await readItem()).toMatchObject({ status: "pending", reviewedAt: null });
    expect(await prisma.adminAuditLog.count({ where: { targetId: itemId } })).toBe(0);
  });

  it("rejects, publishes the result to the applicant, and resets review evidence on resubmission", async () => {
    const before = await readItem();
    const reason = "Please provide an active promotion channel";
    const body = { status: "rejected", reason, confirmation: itemId, expectedUpdatedAt: before.updatedAt };
    const rejected = await decide("reject", body);
    expectOk(rejected);
    expect(rejected.data.item).toMatchObject({ status: "rejected", reviewNote: reason });
    expect(rejected.data.item.reviewedAt).toBeTruthy();
    const dashboard = await api("GET", "affiliate/dashboard", { userId: customerId });
    expectOk(dashboard);
    expect(dashboard.data.application).toMatchObject({ status: "rejected", reviewNote: reason });
    const replay = await decide("reject", body);
    expectOk(replay);
    expect(replay.data.replayed).toBe(true);
    expect(await prisma.adminAuditLog.count({ where: { targetId: itemId } })).toBe(1);
    expectError(await api("POST", "affiliate/click", { body: { code: itemId, visitorKey: `${prefix}visitor` } }), 404);
    const reapplied = await api("POST", "affiliate/application", { userId: customerId, body: { ...application, channels: ["https://example.test/active"] } });
    expectOk(reapplied, 201);
    expect(reapplied.data).toMatchObject({ id: itemId, status: "pending", reviewedAt: null, reviewNote: null });
    expectError(await decide("stale", { ...body, status: "approved" }), 409);
  });

  it("allows one concurrent decision, enables approved attribution, and preserves approval on reapply", async () => {
    const before = await readItem();
    const body = { status: "approved", reason: "Promotion channel verified", confirmation: itemId, expectedUpdatedAt: before.updatedAt };
    const results = await Promise.all([decide("approve-a", body), decide("approve-b", body)]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
    const approved = results.find((result) => result.status === 200)!;
    expect(approved.data.item).toMatchObject({ status: "approved", termsVersion: application.termsVersion });
    expect(await prisma.adminAuditLog.count({ where: { targetId: itemId } })).toBe(2);
    const clickBody = { code: itemId, visitorKey: `${prefix}visitor`, landingPath: "/" };
    const click = await api("POST", "affiliate/click", { body: clickBody });
    expectOk(click, 201);
    const duplicate = await api("POST", "affiliate/click", { body: clickBody });
    expectOk(duplicate, 201);
    expect(duplicate.data.id).toBe(click.data.id);
    const reapplied = await api("POST", "affiliate/application", { userId: customerId, body: { termsVersion: "unreviewed", channels: ["changed"] } });
    expectOk(reapplied, 201);
    expect(reapplied.data).toMatchObject({ status: "approved", termsVersion: application.termsVersion, channels: ["https://example.test/active"] });
    const dashboard = await api("GET", "affiliate/dashboard", { userId: customerId });
    expect(dashboard.data).toMatchObject({ status: "approved", clicks: 1, conversions: 0 });
  });

  it("paginates filtered application evidence and rejects a cursor reused for another status", async () => {
    for (let index = 0; index < 3; index += 1) {
      const userId = `${prefix}customer-${index}`;
      await createUser({ id: userId });
      expectOk(await api("POST", "affiliate/application", { userId, body: application }), 201);
    }
    const options = { userId: adminId, role: "admin", query: { status: "all", search: prefix, limit: 2 } };
    const first = await adminV2("GET", "affiliate/applications", options);
    expectOk(first);
    expect(first.data.items).toHaveLength(2);
    const next = await adminV2("GET", "affiliate/applications", { ...options, query: { ...options.query, cursor: first.data.pageInfo.endCursor } });
    expectOk(next);
    expect(next.data.items).toHaveLength(2);
    expect(new Set([...first.data.items, ...next.data.items].map((item: { id: string }) => item.id)).size).toBe(4);
    expectError(await adminV2("GET", "affiliate/applications", { ...options, query: { ...options.query, status: "pending", cursor: first.data.pageInfo.endCursor } }), 400);
  });
});
