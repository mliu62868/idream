import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  PromoWorkspace,
  isoFromLocalDateTime,
  strictIntegerFromText,
} from "./PromoWorkspace";

describe("redeem code expiry", () => {
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
