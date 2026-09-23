import { describe, expect, it, vi } from "vitest";
import { AFFILIATE_ATTRIBUTION_WINDOW_DAYS, affiliateApplicationSchema, affiliateDashboard, applyAffiliate, attributeAffiliateSignup, recordAffiliateClick, type AffiliateDb, type AffiliateTerms } from "./affiliate";

const published: AffiliateTerms = { state: "published", version: "2026-09", title: "Affiliate program", path: "/affiliate" };

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
    const db = { affiliateClick: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) } } as unknown as Pick<AffiliateDb, "affiliateClick">;
    await expect(attributeAffiliateSignup(db, "app-1:visitor-1234", "new-user", now)).resolves.toBe(1);
    expect(db.affiliateClick.updateMany).toHaveBeenCalledWith({
      where: {
        code: "app-1", visitorKey: "visitor-1234", convertedAt: null, affiliateUserId: { not: "new-user" },
        createdAt: { gte: new Date(now.getTime() - AFFILIATE_ATTRIBUTION_WINDOW_DAYS * 86_400_000) },
      },
      data: { convertedAt: now },
    });
    await expect(attributeAffiliateSignup(db, undefined, "new-user", now)).resolves.toBe(0);
    await expect(attributeAffiliateSignup(db, "malformed", "new-user", now)).resolves.toBe(0);
    expect(db.affiliateClick.updateMany).toHaveBeenCalledTimes(1);
  });

  it("deduplicates clicks by code and visitor key", async () => {
    const click = { id: "click-1", code: "app-1", visitorKey: "visitor-1234" };
    const db = {
      affiliateApplication: { findFirst: vi.fn().mockResolvedValue({ id: "app-1", userId: "u1", status: "approved" }) },
      affiliateClick: { upsert: vi.fn().mockResolvedValue(click) },
    } as unknown as AffiliateDb;
    await expect(recordAffiliateClick(db, "app-1", "visitor-1234", "/pricing")).resolves.toEqual(click);
    expect(db.affiliateClick.upsert).toHaveBeenCalledWith(expect.objectContaining({ where: { code_visitorKey: { code: "app-1", visitorKey: "visitor-1234" } } }));
  });

  it("reports dashboard conversion counts", async () => {
    const db = {
      affiliateApplication: { findUnique: vi.fn().mockResolvedValue({ id: "app-1", status: "approved", termsVersion: "2026-09", channels: ["x"], reviewedAt: null }) },
      affiliateClick: { count: vi.fn().mockResolvedValueOnce(4).mockResolvedValueOnce(2) },
    } as unknown as AffiliateDb;
    await expect(affiliateDashboard(db, "u1")).resolves.toMatchObject({ clicks: 4, conversions: 2, status: "approved", linkPath: "/?aff=app-1" });
  });
});
