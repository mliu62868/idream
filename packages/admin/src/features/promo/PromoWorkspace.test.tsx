import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  PromoWorkspace,
  isoFromLocalDateTime,
  strictIntegerFromText,
  redeemCodeDisplayStatus,
} from "./PromoWorkspace";

describe("redeem code expiry", () => {
  const asOf = "2026-09-29T12:00:00.000Z";
  it("distinguishes enabled codes from codes that can still be redeemed", () => {
    expect(redeemCodeDisplayStatus({ status: "active", expiresAt: asOf }, asOf)).toBe("expired");
    expect(redeemCodeDisplayStatus({ status: "active", redemptions: 1, maxRedemptions: 1 }, asOf)).toBe("exhausted");
    expect(redeemCodeDisplayStatus({ status: "active", redemptions: 100, maxRedemptions: null }, asOf)).toBe("active");
    expect(redeemCodeDisplayStatus({ status: "active", expiresAt: "2026-10-01T00:00:00.000Z", maxRedemptions: 2, redemptions: 1 }, asOf)).toBe("active");
    expect(redeemCodeDisplayStatus({ status: "disabled", expiresAt: asOf, maxRedemptions: 1, redemptions: 1 }, asOf)).toBe("disabled");
  });
  // INTENT: 契约收 ISO，输入框给的是本地时间串；解不出来就得挡住，不能把 Invalid Date 发出去。
  it("converts a local datetime-local value to an ISO instant", () => {
    expect(isoFromLocalDateTime("2026-09-01T12:00")).toBe(
      new Date("2026-09-01T12:00").toISOString(),
    );
  });

  it("treats a blank or unparseable expiry as no expiry", () => {
    expect(isoFromLocalDateTime("")).toBeNull();
    expect(isoFromLocalDateTime("   ")).toBeNull();
    expect(isoFromLocalDateTime("not a date")).toBeNull();
  });
});

describe("Promo workspace permissions", () => {
  it("keeps independent authorities visible in read-only mode", () => {
    const html = renderToStaticMarkup(<PromoWorkspace canWrite={false} />);
    expect(html).toContain("Redeem codes: loading");
    expect(html).toContain("Referrals: loading");
    expect(html).toContain("Creating and disabling redeem codes is unavailable");
    expect(html).not.toContain("is not granted");
    expect(html).not.toContain("Create redeem code</h2>");
  });
});

describe("promo reward input", () => {
  it.each(["", "0", "1.5", "1e3", "12abc", "-1", "1000001"])(
    "rejects ambiguous or out-of-range value %s",
    (value) => {
      expect(strictIntegerFromText(value, 1, 1_000_000)).toBeNull();
    },
  );

  it("accepts only an explicitly entered whole-number reward", () => {
    expect(strictIntegerFromText("1", 1, 1_000_000)).toBe(1);
    expect(strictIntegerFromText(" 250 ", 1, 1_000_000)).toBe(250);
    expect(strictIntegerFromText("1000000", 1, 1_000_000)).toBe(1_000_000);
  });
});
