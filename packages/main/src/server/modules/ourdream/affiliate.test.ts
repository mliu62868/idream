import { afterEach, describe, expect, it, vi } from "vitest";
import { affiliateApplicationSchema } from "@idream/shared/contracts";
import { AFFILIATE_ATTRIBUTION_WINDOW_DAYS, affiliateDashboard, applyAffiliate, attributeAffiliateSignup, recordAffiliateClick, type AffiliateDb, type AffiliateTerms } from "./affiliate";

const published: AffiliateTerms = { state: "published", version: "2026-09", title: "Affiliate program", path: "/affiliate" };
afterEach(() => vi.useRealTimers());

describe("affiliate domain", () => {
  it("validates versioned application and is idempotent for approved creators", async () => {
    const approved = { id: "app-1", userId: "u1", status: "approved", termsVersion: "2026-09", channels: ["youtube"], reviewedAt: new Date() };
    const db = {
      affiliateApplication: {
        findUnique: vi.fn().mockResolvedValue(approved),
        upsert: vi.fn(),
      },
    } as unknown as AffiliateDb;
    expect(affiliateApplicationSchema.parse({ termsVersion: "2026-09", channels: ["youtube"] })).toEqual({ termsVersion: "2026-09", channels: ["youtube"] });
    await expect(applyAffiliate(db, "u1", { termsVersion: "2026-09", channels: ["youtube"] }, published)).resolves.toEqual(approved);
    expect(db.affiliateApplication.upsert).not.toHaveBeenCalled();
  });

  it("accepts applications only against the currently published terms version", async () => {
    const db = {
      affiliateApplication: { findUnique: vi.fn().mockResolvedValue(null), upsert: vi.fn(), updateMany: vi.fn() },
    } as unknown as AffiliateDb;
    const body = { termsVersion: "2026-09", channels: ["youtube"] };
    await expect(applyAffiliate(db, "u1", body, { state: "unpublished" })).rejects.toThrow(/not published/);
    await expect(applyAffiliate(db, "u1", { ...body, termsVersion: "2026-08" }, published)).rejects.toThrow(/terms changed/);
    expect(db.affiliateApplication.upsert).not.toHaveBeenCalled();
  });

  it("converts the cookie's click once, inside the window, never for the affiliate's own signup", async () => {
    const now = new Date("2026-09-23T00:00:00Z");
    const db = { affiliateClick: { findUnique: vi.fn().mockResolvedValue({ id: "click-1", affiliateUserId: "partner", createdAt: new Date(now.getTime() - AFFILIATE_ATTRIBUTION_WINDOW_DAYS * 86_400_000), convertedAt: null, attributionWindowDays: 30 }), updateMany: vi.fn().mockResolvedValue({ count: 1 }) } } as unknown as Pick<AffiliateDb, "affiliateClick">;
    await expect(attributeAffiliateSignup(db, "app-1:visitor-1234", "new-user", now)).resolves.toBe(1);
    expect(db.affiliateClick.updateMany).toHaveBeenCalledWith({
      where: { id: "click-1", convertedAt: null },
      data: { convertedAt: now, convertedUserId: "new-user" },
    });
    await expect(attributeAffiliateSignup(db, undefined, "new-user", now)).resolves.toBe(0);
    await expect(attributeAffiliateSignup(db, "malformed", "new-user", now)).resolves.toBe(0);
    expect(db.affiliateClick.updateMany).toHaveBeenCalledTimes(1);
  });

  it("mints independent opaque visitor keys internally for visits without a valid cookie", async () => {
    const db = {
      affiliateApplication: { findFirst: vi.fn().mockResolvedValue({ id: "app-1", userId: "u1", status: "approved", termsVersion: "2026-09" }) },
      affiliateClick: { create: vi.fn().mockImplementation(async ({ data }) => data) },
    } as unknown as AffiliateDb;
    const input = { code: "app-1", cookieVisitorKey: null, landingPath: "/pricing", viewerUserId: undefined };
    const first = await recordAffiliateClick(db, input), second = await recordAffiliateClick(db, input);
    expect(first!.visitorKey).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(first!.visitorKey).not.toBe(second!.visitorKey);
    expect(first).toMatchObject({ affiliateUserId: "u1", code: "app-1", landingPath: "/pricing", attributionVersion: "affiliate-signup-v1", attributionWindowDays: 30, termsVersion: "2026-09" });
    expect(db.affiliateClick.create).toHaveBeenCalledTimes(2);
  });

  it.each([30 * 86_400_000 - 1, 30 * 86_400_000, 30 * 86_400_000 + 1])("reuses a cookie's click only inside the attribution window (age=%s ms)", async (age) => {
    const now = new Date("2026-10-01T00:00:00.000Z");
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(now);
    const oldClick = { id: "old-click", code: "app-1", visitorKey: "old-window", createdAt: new Date(now.getTime() - age) };
    const freshClick = { id: "fresh-click", code: "app-1", visitorKey: "current-window", createdAt: now };
    const db = {
      affiliateApplication: { findFirst: vi.fn().mockResolvedValue({ id: "app-1", userId: "u1", status: "approved" }) },
      affiliateClick: { findUnique: vi.fn().mockResolvedValue(oldClick), create: vi.fn().mockResolvedValue(freshClick) },
    } as unknown as AffiliateDb;
    const result = await recordAffiliateClick(db, { code: "app-1", cookieVisitorKey: "old-window", landingPath: "/", viewerUserId: undefined });
    expect(result).toEqual(age <= 30 * 86_400_000 ? oldClick : freshClick);
    expect(db.affiliateClick.create).toHaveBeenCalledTimes(age <= 30 * 86_400_000 ? 0 : 1);
  });

  it("reports dashboard conversion counts", async () => {
    const db = {
      affiliateApplication: { findUnique: vi.fn().mockResolvedValue({ id: "app-1", status: "approved", termsVersion: "2026-09", channels: ["x"], reviewedAt: null }) },
      affiliateClick: { count: vi.fn().mockResolvedValueOnce(4).mockResolvedValueOnce(2), findMany: vi.fn().mockResolvedValue([]) },
      character: { findMany: vi.fn().mockResolvedValue([]) },
    } as unknown as AffiliateDb;
    await expect(affiliateDashboard(db, "u1")).resolves.toMatchObject({ clicks: 4, conversions: 2, status: "approved", linkPath: "/?aff=app-1" });
  });
});
