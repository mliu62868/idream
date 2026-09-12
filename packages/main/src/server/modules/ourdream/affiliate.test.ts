import { describe, expect, it, vi } from "vitest";
import { affiliateApplicationSchema, affiliateDashboard, applyAffiliate, recordAffiliateClick } from "./affiliate";

describe("affiliate domain", () => {
  it("validates versioned application and is idempotent for approved creators", async () => {
    const approved = { id: "app-1", userId: "u1", status: "approved", termsVersion: "2026-09", channels: ["youtube"], reviewedAt: new Date() };
    const db = {
      affiliateApplication: {
        findUnique: vi.fn().mockResolvedValue(approved),
        upsert: vi.fn(),
      },
    } as any;
    expect(affiliateApplicationSchema.parse({ termsVersion: "2026-09", channels: ["youtube"] })).toEqual({ termsVersion: "2026-09", channels: ["youtube"] });
    await expect(applyAffiliate(db, "u1", { termsVersion: "2026-09", channels: ["youtube"] })).resolves.toEqual(approved);
    expect(db.affiliateApplication.upsert).not.toHaveBeenCalled();
  });

  it("deduplicates clicks by code and visitor key", async () => {
    const click = { id: "click-1", code: "app-1", visitorKey: "visitor-1234" };
    const db = {
      affiliateApplication: { findFirst: vi.fn().mockResolvedValue({ id: "app-1", userId: "u1", status: "approved" }) },
      affiliateClick: { upsert: vi.fn().mockResolvedValue(click) },
    } as any;
    await expect(recordAffiliateClick(db, "app-1", "visitor-1234", "/pricing")).resolves.toEqual(click);
    expect(db.affiliateClick.upsert).toHaveBeenCalledWith(expect.objectContaining({ where: { code_visitorKey: { code: "app-1", visitorKey: "visitor-1234" } } }));
  });

  it("reports dashboard conversion counts", async () => {
    const db = {
      affiliateApplication: { findUnique: vi.fn().mockResolvedValue({ id: "app-1", status: "approved", termsVersion: "2026-09", channels: ["x"], reviewedAt: null }) },
      affiliateClick: { count: vi.fn().mockResolvedValueOnce(4).mockResolvedValueOnce(2) },
    } as any;
    await expect(affiliateDashboard(db, "u1")).resolves.toMatchObject({ clicks: 4, conversions: 2, status: "approved" });
  });
});
