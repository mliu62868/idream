import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { api, cookieHeader, createUser, expectError, expectOk, purgeTestData } from "@/server/test/helpers";

const prefix = `zt-affiliate-${randomUUID()}-`;
const signedUp: string[] = [];
afterAll(async () => {
  await prisma.routePage.deleteMany({ where: { path: "/affiliate", title: { startsWith: prefix } } });
  await prisma.affiliateApplication.deleteMany({ where: { userId: { startsWith: prefix } } });
  await prisma.user.deleteMany({ where: { id: { in: signedUp } } });
  await purgeTestData(prefix);
  await prisma.$disconnect();
});

describe("affiliate user journey (AF-01 / AF-02)", () => {
  it("closes applications until terms are published, then attributes a signup from the promo link", async () => {
    const affiliate = `${prefix}partner`;
    await createUser({ id: affiliate });
    const closed = await api("GET", "affiliate/dashboard", { userId: affiliate });
    expectOk(closed);
    expect(closed.data).toMatchObject({ status: "not_applied", terms: { state: "unpublished" } });
    expectError(await api("POST", "affiliate/application", {
      userId: affiliate, body: { termsVersion: "anything", channels: ["youtube"] },
    }), 409, "conflict");

    // The seed has no /affiliate page; this test publishes one and removes it.
    await prisma.routePage.create({ data: {
      path: "/affiliate", template: "article", title: `${prefix}Affiliate program`,
      description: "Program terms for creators who promote iDream to adult audiences.",
      contentStatus: "published", contentSchemaVersion: 1, indexingStatus: "noindex", canonical: null,
      publishedAt: new Date("2026-09-20T00:00:00Z"),
      body: {
        heading: "Affiliate program",
        intro: "These are the terms that apply to every approved affiliate partner of iDream.",
        sections: [
          { heading: "Attribution", paragraphs: ["A signup counts when it follows your link within the attribution window."] },
          { heading: "Payouts", paragraphs: ["Commission and settlement terms are published separately before any payout."] },
        ],
      },
    } });
    const open = await api("GET", "affiliate/dashboard", { userId: affiliate });
    expectOk(open);
    expect(open.data.terms).toMatchObject({ state: "published", version: "2026-09-20T00:00:00.000Z" });
    const version = open.data.terms.version as string;
    expectError(await api("POST", "affiliate/application", {
      userId: affiliate, body: { termsVersion: "stale", channels: ["youtube"] },
    }), 409, "conflict");
    const applied = await api("POST", "affiliate/application", {
      userId: affiliate, body: { termsVersion: version, channels: ["youtube"] },
    });
    expectOk(applied, 201);
    const pending = await api("GET", "affiliate/dashboard", { userId: affiliate });
    expect(pending.data).toMatchObject({ status: "pending", linkPath: null });

    await prisma.affiliateApplication.update({ where: { userId: affiliate }, data: { status: "approved", reviewedAt: new Date() } });
    const approved = await api("GET", "affiliate/dashboard", { userId: affiliate });
    const code = approved.data.application.id as string;
    expect(approved.data.linkPath).toBe(`/?aff=${code}`);

    const click = await api("POST", "affiliate/click", { body: { code, visitorKey: `${prefix}visitor`, landingPath: "/" } });
    expectOk(click, 201);
    const email = `${prefix}invitee@customer.invalid`;
    const signup = await api("POST", "auth/signup", {
      cookie: cookieHeader(click.setCookies),
      body: { email, password: "Affiliate-signup-0923!", name: "Invitee" },
    });
    expectOk(signup);
    signedUp.push(signup.data.user.id as string);
    const after = await api("GET", "affiliate/dashboard", { userId: affiliate });
    expect(after.data).toMatchObject({ clicks: 1, conversions: 1 });

    // A second signup from the same browser does not convert the same click again.
    const again = await api("POST", "auth/signup", {
      cookie: cookieHeader(click.setCookies),
      body: { email: `${prefix}second@customer.invalid`, password: "Affiliate-signup-0923!", name: "Second" },
    });
    expectOk(again);
    signedUp.push(again.data.user.id as string);
    expect((await api("GET", "affiliate/dashboard", { userId: affiliate })).data.conversions).toBe(1);
  });
});

// SPEC: 同一推广码同一访客（服务端可见的 IP/UA）窗口内只记一次；客户端自报的 visitorKey 与伪造 cookie 都不能凭空造点击；推广者点自己的链接不计。
describe("affiliate click deduplication", () => {
  async function approvedAffiliate() {
    const userId = `${prefix}${randomUUID()}`;
    await createUser({ id: userId });
    const app = await prisma.affiliateApplication.create({
      data: { id: `${userId}-code`, userId, status: "approved", termsVersion: "v1", channels: ["youtube"], reviewedAt: new Date() },
    });
    return { userId, code: app.id };
  }
  const from = (ip: string, userAgent = "Mozilla/5.0 fixture") => ({ "x-forwarded-for": ip, "user-agent": userAgent });
  const clicks = (code: string) => prisma.affiliateClick.count({ where: { code } });

  it("counts one click per visitor whatever key the client sends", async () => {
    const { code } = await approvedAffiliate();
    const first = await api("POST", "affiliate/click", { headers: from("203.0.113.7"), body: { code, visitorKey: `${prefix}a-key-1`, landingPath: "/" } });
    expectOk(first, 201);
    const second = await api("POST", "affiliate/click", { headers: from("203.0.113.7"), body: { code, visitorKey: `${prefix}a-key-2`, landingPath: "/" } });
    expect(second.data.id).toBe(first.data.id);
    expect(await clicks(code)).toBe(1);

    const forged = await api("POST", "affiliate/click", {
      headers: { ...from("203.0.113.8"), cookie: `idream_affiliate=${code}:${prefix}made-up` },
      body: { code, landingPath: "/" },
    });
    expectOk(forged, 201);
    expect((await prisma.affiliateClick.findUniqueOrThrow({ where: { id: forged.data.id } })).visitorKey).not.toBe(`${prefix}made-up`);
    expect(await clicks(code)).toBe(2);

    // The browser that already clicked keeps its click after its address changes.
    const moved = await api("POST", "affiliate/click", {
      headers: { ...from("198.51.100.4"), cookie: cookieHeader(first.setCookies) },
      body: { code, landingPath: "/" },
    });
    expect(moved.data.id).toBe(first.data.id);
    expect(await clicks(code)).toBe(2);
  });

  it("does not count the promoter's own click or hand them an attribution cookie", async () => {
    const { userId, code } = await approvedAffiliate();
    const own = await api("POST", "affiliate/click", { userId, headers: from("203.0.113.9"), body: { code, landingPath: "/" } });
    expectOk(own);
    expect(own.data.id).toBeNull();
    expect(own.setCookies.some((cookie) => cookie.startsWith("idream_affiliate="))).toBe(false);
    expect(await clicks(code)).toBe(0);
  });

  it("rate limits the public click endpoint per address", async () => {
    const { code } = await approvedAffiliate();
    const previous = process.env.RATE_LIMIT_FORCE;
    process.env.RATE_LIMIT_FORCE = "1";
    try {
      const ip = `192.0.2.${Math.floor(Math.random() * 200) + 1}-${randomUUID()}`;
      for (let index = 0; index < 30; index += 1) {
        expectOk(await api("POST", "affiliate/click", { headers: from(ip, `agent-${index}`), body: { code, landingPath: "/" } }), 201);
      }
      expectError(await api("POST", "affiliate/click", { headers: from(ip, "agent-over"), body: { code, landingPath: "/" } }), 429);
    } finally {
      if (previous === undefined) delete process.env.RATE_LIMIT_FORCE;
      else process.env.RATE_LIMIT_FORCE = previous;
    }
  });
});
