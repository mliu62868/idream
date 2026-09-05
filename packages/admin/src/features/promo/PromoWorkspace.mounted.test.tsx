// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminI18nProvider } from "@/components/admin/i18n";
import { PromoWorkspace } from "./PromoWorkspace";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("Promo table column identity", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const path = String(input);
      const items = path.includes("/redeem-codes")
        ? [{ id: "code-one", status: "active", reward: { dreamcoins: 100 }, maxRedemptions: 3, redemptions: 1 }]
        : path.includes("/referrals")
          ? [{ id: "referral-one", inviterId: "inviter", inviteeId: "invitee", status: "completed", rewardStatus: "granted" }]
          : null;
      if (!items) throw new Error(`Unexpected request: ${path}`);
      return Response.json({ ok: true, data: { items, pageInfo: { endCursor: null, hasNextPage: false } } });
    }));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it.each(["en", "zh"] as const)("keeps redeem-code columns aligned after %s localization", async (locale) => {
    await act(async () => root.render(
      <AdminI18nProvider locale={locale}><PromoWorkspace canWrite={false} /></AdminI18nProvider>,
    ));
    const tables = [...container.querySelectorAll("table")];
    expect(tables).toHaveLength(2);
    const codeTable = tables[0]!;
    const referralTable = tables[1]!;
    expect(codeTable.querySelector("caption")?.textContent).toBe(locale === "zh" ? "兑换码" : "Redeem codes");
    expect(codeTable.querySelectorAll("th")).toHaveLength(8);
    expect(codeTable.querySelector("tbody tr")?.children).toHaveLength(8);
    expect(codeTable.querySelectorAll("th")[2]?.textContent).toBe(locale === "zh" ? "奖励" : "Reward");
    expect(referralTable.querySelectorAll("th")).toHaveLength(6);
    expect(referralTable.querySelector("tbody tr")?.children).toHaveLength(6);
  });
});
