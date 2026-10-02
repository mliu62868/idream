import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/server/lib/db";
import { api, cookieHeader, createUser, expectError, expectOk, purgeTestData } from "@/server/test/helpers";

const prefix = `zt-affiliate-${randomUUID()}-`;
const signedUp: string[] = [];
afterEach(() => vi.useRealTimers());
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

// AF-02: IP/UA can be shared by different customers. Deduplication follows a
// valid server-issued cookie; unknown client identities receive a fresh token.
// Promoters' own traffic is excluded, and IP request limits remain independent.
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

  it("attributes separate browser signups independently when their address and Chrome agent are identical", async () => {
    const { userId, code } = await approvedAffiliate();
    const headers = from("203.0.113.40", "Mozilla/5.0 Chrome/154.0.0.0");
    const firstBrowser = await api("POST", "affiliate/click", { headers, body: { code, landingPath: "/" } });
    const secondBrowser = await api("POST", "affiliate/click", { headers, body: { code, landingPath: "/" } });
    expectOk(firstBrowser, 201); expectOk(secondBrowser, 201);
    const invitees: string[] = [];
    for (const click of [firstBrowser, secondBrowser]) {
      const signup = await api("POST", "auth/signup", {
        headers, cookie: cookieHeader(click.setCookies),
        body: { email: `${prefix}${randomUUID()}@customer.invalid`, password: "Affiliate-signup-1002!", name: "Shared network invitee" },
      });
      expectOk(signup); signedUp.push(signup.data.user.id as string); invitees.push(signup.data.user.id as string);
    }
    const dashboard = await api("GET", "affiliate/dashboard", { userId }); expectOk(dashboard);
    expect(dashboard.data).toMatchObject({ clicks: 2, conversions: 2 });
    expect(secondBrowser.data.id).not.toBe(firstBrowser.data.id);
    const converted = await prisma.affiliateClick.findMany({ where: { code }, select: { convertedUserId: true } });
    expect(converted.map(click => click.convertedUserId).sort()).toEqual(invitees.sort());
  });

  it("mints a fresh opaque visitor token when the body or an unknown cookie names a token", async () => {
    const { code } = await approvedAffiliate(), namedToken = randomUUID();
    const headers = from("203.0.113.41", "Mozilla/5.0 Chrome/154.0.0.0");
    const first = await api("POST", "affiliate/click", {
      headers, cookie: `idream_affiliate=${code}:${namedToken}`, body: { code, visitorKey: namedToken, landingPath: "/" },
    }); expectOk(first, 201);
    const firstRow = await prisma.affiliateClick.findUniqueOrThrow({ where: { id: first.data.id } });
    expect(firstRow.visitorKey).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(firstRow.visitorKey).not.toBe(namedToken);
    const second = await api("POST", "affiliate/click", {
      headers, cookie: `idream_affiliate=${code}:${namedToken}`, body: { code, visitorKey: firstRow.visitorKey, landingPath: "/" },
    }); expectOk(second, 201);
    const secondRow = await prisma.affiliateClick.findUniqueOrThrow({ where: { id: second.data.id } });
    expect(secondRow.visitorKey).not.toBe(namedToken); expect(secondRow.visitorKey).not.toBe(firstRow.visitorKey);
    expect(secondRow.id).not.toBe(firstRow.id); expect(await clicks(code)).toBe(2);
  });

  it("reuses one valid cookie's click regardless of client-named keys or an address change", async () => {
    const { code } = await approvedAffiliate();
    const first = await api("POST", "affiliate/click", { headers: from("203.0.113.7"), body: { code, visitorKey: `${prefix}a-key-1`, landingPath: "/" } });
    expectOk(first, 201);
    const second = await api("POST", "affiliate/click", { headers: from("203.0.113.7"), cookie: cookieHeader(first.setCookies), body: { code, visitorKey: `${prefix}a-key-2`, landingPath: "/" } });
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

  it("attributes a real signup after day 0, day 25 and day 35 visits without extending an expired click", async () => {
    const { userId, code } = await approvedAffiliate();
    const day0 = new Date();
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(day0);
    const visitorHeaders = from("203.0.113.35", `${prefix}returning-browser`);
    const first = await api("POST", "affiliate/click", { headers: visitorHeaders, body: { code, landingPath: "/" } });
    expectOk(first, 201);
    vi.setSystemTime(new Date(day0.getTime() + 25 * 86_400_000));
    const day25 = await api("POST", "affiliate/click", { cookie: cookieHeader(first.setCookies), headers: visitorHeaders, body: { code, landingPath: "/" } });
    expectOk(day25, 201);
    expect(day25.data.id).toBe(first.data.id);
    expect(await clicks(code)).toBe(1);
    vi.setSystemTime(new Date(day0.getTime() + 35 * 86_400_000));
    const day35 = await api("POST", "affiliate/click", { cookie: cookieHeader(day25.setCookies), headers: visitorHeaders, body: { code, landingPath: "/" } });
    expectOk(day35, 201);
    const signup = await api("POST", "auth/signup", {
      cookie: cookieHeader(day35.setCookies),
      body: { email: `${prefix}returning-invitee@customer.invalid`, password: "Affiliate-signup-1001!", name: "Returning invitee" },
    });
    expectOk(signup); signedUp.push(signup.data.user.id as string);
    const dashboard = await api("GET", "affiliate/dashboard", { userId });
    expectOk(dashboard);
    expect(dashboard.data).toMatchObject({ clicks: 2, conversions: 1 });
    expect(day35.data.id).not.toBe(first.data.id);
    const current = await prisma.affiliateClick.findUniqueOrThrow({ where: { id: day35.data.id } });
    expect(current).toMatchObject({ affiliateUserId: userId, convertedAt: new Date(day0.getTime() + 35 * 86_400_000) });
    expect((await prisma.affiliateClick.findUniqueOrThrow({ where: { id: first.data.id } })).convertedAt).toBeNull();
    const repeated = await api("POST", "affiliate/click", { cookie: cookieHeader(day35.setCookies), headers: from("198.51.100.35", "Changed network"), body: { code, landingPath: "/" } });
    expectOk(repeated, 201); expect(repeated.data.id).toBe(current.id); expect(await clicks(code)).toBe(2);
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
