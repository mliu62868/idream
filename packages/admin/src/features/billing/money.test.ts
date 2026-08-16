import { describe, expect, it } from "vitest";
import { dreamcoins, fiat, signedDreamcoins } from "./money";

describe("dreamcoin display", () => {
  // SPEC: 四位数以上必须分组。这是运营把 1500 读成 15000 的唯一防线。
  it("groups thousands so long balances stay readable", () => {
    expect(dreamcoins(1_500)).toBe("1,500");
    expect(dreamcoins(1_000_000)).toBe("1,000,000");
    expect(dreamcoins(0)).toBe("0");
  });

  // SPEC: 账本增减带符号，正数也写 +。
  it("always signs a ledger delta", () => {
    expect(signedDreamcoins(1_500)).toBe("+1,500");
    expect(signedDreamcoins(-1_500)).toBe("-1,500");
    expect(signedDreamcoins(0)).toBe("0");
  });

  // INVARIANT: 拿不到数字就说拿不到，不印 0 —— 钱的地方 0 和「未知」不是一回事。
  it("refuses to render a non-finite amount as a number", () => {
    expect(dreamcoins(Number.NaN)).toBe("—");
    expect(signedDreamcoins(Number.POSITIVE_INFINITY)).toBe("—");
  });
});

describe("provider amount display", () => {
  it("formats cents in the currency the authority reported", () => {
    expect(fiat(1_999, "usd")).toBe("$19.99");
    expect(fiat(1_999, "USD")).toBe("$19.99");
  });

  // INTENT: 币种是后端自由字符串。认不出来时把数值和原始币种一起印出来，
  //         绝不悄悄退回美元——那会把一笔欧元退款显示成美元金额。
  it("keeps the raw currency visible instead of defaulting to dollars", () => {
    expect(fiat(1_999, "not-a-currency")).toBe("19.99 not-a-currency");
  });

  it("falls back to dollars only when the authority reported no currency at all", () => {
    expect(fiat(1_999, null)).toBe("$19.99");
  });
});
