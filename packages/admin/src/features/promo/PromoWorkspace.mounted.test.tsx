// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminI18nProvider } from "@/components/admin/i18n";
import { ToastProvider } from "@/components/admin/ui/Toast";
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

  it("filters completed referrals while keeping granted and ineligible rewards distinct", async () => {
    window.history.replaceState(null, "", "/admin/growth/offers?view=promo");
    const referrals = [
      { id: "referral-pending", inviterId: "inviter", inviteeId: null, status: "pending", rewardStatus: "none" },
      { id: "referral-granted", inviterId: "inviter", inviteeId: "eligible", status: "completed", rewardStatus: "granted" },
      { id: "referral-ineligible", inviterId: "inviter", inviteeId: "ineligible", status: "completed", rewardStatus: "not_eligible" },
    ];
    const reads: URL[] = [];
    const writes: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input), window.location.origin);
      if (init?.method && init.method !== "GET") writes.push(url.pathname);
      let items: typeof referrals = [];
      if (url.pathname.endsWith("/referrals")) {
        reads.push(url);
        const status = url.searchParams.get("status");
        items = referrals.filter((row) => !status || row.status === status);
      }
      return Response.json({ ok: true, data: { items, pageInfo: { endCursor: null, hasNextPage: false } } });
    }));
    await act(async () => root.render(<AdminI18nProvider locale="en"><PromoWorkspace canWrite={false} /></AdminI18nProvider>));
    const status = [...container.querySelectorAll("label")].find((node) => node.firstChild?.textContent === "Referral status")!.querySelector("select")!;
    const filter = [...container.querySelectorAll("button")].find((node) => node.textContent === "Filter promotions")!;
    // A completed conversion must be selectable through the public control.
    expect([...status.options].some((option) => option.value === "completed")).toBe(true);
    await act(async () => {
      status.value = "completed";
      status.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => filter.click());
    expect(reads.at(-1)?.searchParams.get("status")).toBe("completed");
    expect(new URLSearchParams(window.location.search).get("referralStatus")).toBe("completed");
    const referralRows = () => [...container.querySelectorAll("table")].find((table) => table.querySelector("caption")?.textContent === "Referrals")!.querySelectorAll("tbody tr");
    expect([...referralRows()].map((row) => row.children[0]?.textContent)).toEqual(["referral-granted", "referral-ineligible"]);
    expect([...referralRows()].map((row) => row.children[4]?.textContent)).toEqual(["granted", "Not eligible"]);

    await act(async () => {
      status.value = "pending";
      status.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => filter.click());
    expect(reads.at(-1)?.searchParams.get("status")).toBe("pending");
    expect(referralRows()).toHaveLength(1);
    expect(referralRows()[0]?.textContent).toContain("referral-pending");
    expect(writes).toEqual([]);
  });

  it.each(["revoked", "revoked then regranted"] as const)("invalidates an already-filled disable confirmation when write permission is %s", async (permissionChange) => {
    window.history.replaceState(null, "", "/admin/growth/offers?view=promo");
    const writes: Array<{ path: string; method: string; body: unknown }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input), window.location.origin).pathname;
      if (init?.method === "POST") {
        writes.push({ path, method: init.method, body: JSON.parse(String(init.body)) });
        return Response.json({ ok: true, data: {} });
      }
      const items = path.endsWith("/redeem-codes")
        ? [{ id: "code-one", status: "active", reward: { dreamcoins: 100 }, maxRedemptions: 3, redemptions: 1 }]
        : [];
      return Response.json({ ok: true, data: { items, pageInfo: { endCursor: null, hasNextPage: false } } });
    }));
    const render = async (canWrite: boolean) => {
      await act(async () => root.render(<AdminI18nProvider locale="en"><PromoWorkspace canWrite={canWrite} /></AdminI18nProvider>));
    };
    const disable = () => [...container.querySelectorAll("button")].find((node) => node.textContent?.trim() === "Disable")!;
    const submit = (dialog: Element) => [...dialog.querySelectorAll("button")].find((node) => node.textContent?.trim() === "Disable")!;
    const fill = async (input: HTMLInputElement, next: string) => {
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, next);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    };
    await render(true);
    await act(async () => disable().click());
    const originalDialog = document.querySelector('[role="dialog"]')!;
    await fill(originalDialog.querySelector('input[aria-label="Reason"]')!, "Original operator intent");
    await fill(originalDialog.querySelector('input[aria-label="Confirmation"]')!, "code-one");
    expect(submit(originalDialog).disabled).toBe(false);
    await render(false);
    if (permissionChange === "revoked then regranted") await render(true);
    const staleDialog = document.querySelector('[role="dialog"]');
    if (staleDialog) await act(async () => submit(staleDialog).click());
    expect(writes).toEqual([]);
    expect(document.querySelector('[role="dialog"]')).toBeNull();

    // A later authorized action must start with a fresh reason and confirmation.
    await render(true);
    await act(async () => disable().click());
    const freshDialog = document.querySelector('[role="dialog"]')!;
    expect(freshDialog.querySelector<HTMLInputElement>('input[aria-label="Reason"]')!.value).toBe("");
    expect(freshDialog.querySelector<HTMLInputElement>('input[aria-label="Confirmation"]')!.value).toBe("");
    await fill(freshDialog.querySelector('input[aria-label="Reason"]')!, "Fresh authorized operator intent");
    await fill(freshDialog.querySelector('input[aria-label="Confirmation"]')!, "code-one");
    await act(async () => submit(freshDialog).click());
    expect(writes).toEqual([{
      path: "/api/v2/admin/promo/redeem-codes/code-one/disable",
      method: "POST",
      body: { reason: "Fresh authorized operator intent", confirmation: "code-one" },
    }]);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it.each(["revoke and regrant", "unmount and remount"] as const)("does not project an old disable success over a new query after %s", async (retire) => {
    window.history.replaceState(null, "", "/admin/growth/offers?view=promo&promoSearch=query-a");
    let resolveDisable!: (response: Response) => void;
    const pendingDisable = new Promise<Response>((resolve) => { resolveDisable = resolve; });
    const reads: URL[] = [];
    const writes: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input), window.location.origin);
      if (init?.method === "POST") {
        writes.push(url.pathname);
        return pendingDisable;
      }
      reads.push(url);
      const items = url.pathname.endsWith("/redeem-codes")
        ? [{ id: "code-one", status: "active", reward: { dreamcoins: 100 }, maxRedemptions: 3, redemptions: 1 }]
        : [];
      return Response.json({ ok: true, data: { items, pageInfo: { endCursor: null, hasNextPage: false } } });
    }));
    const render = async (canWrite: boolean) => {
      await act(async () => root.render(<AdminI18nProvider locale="en"><ToastProvider><PromoWorkspace canWrite={canWrite} /></ToastProvider></AdminI18nProvider>));
    };
    const disable = () => [...container.querySelectorAll("button")].find((node) => node.textContent?.trim() === "Disable")!;
    const fill = async (input: HTMLInputElement, next: string) => {
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, next);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    };
    await render(true);
    await act(async () => disable().click());
    const originalDialog = document.querySelector('[role="dialog"]')!;
    await fill(originalDialog.querySelector('input[aria-label="Reason"]')!, "Original authorized operator intent");
    await fill(originalDialog.querySelector('input[aria-label="Confirmation"]')!, "code-one");
    await act(async () => [...originalDialog.querySelectorAll("button")].find((node) => node.textContent?.trim() === "Disable")!.click());
    expect(writes).toEqual(["/api/v2/admin/promo/redeem-codes/code-one/disable"]);
    if (retire === "revoke and regrant") {
      await render(false);
      await render(true);
      await fill(container.querySelector('input[role="searchbox"]')!, "query-b");
      await act(async () => [...container.querySelectorAll("button")].find((node) => node.textContent === "Filter promotions")!.click());
    } else {
      await act(async () => root.unmount());
      window.history.replaceState(null, "", "/admin/growth/offers?view=promo&promoSearch=query-b");
      root = createRoot(container);
      await render(true);
    }
    expect(new URLSearchParams(window.location.search).get("promoSearch")).toBe("query-b");
    await act(async () => disable().click());
    const freshDialog = document.querySelector('[role="dialog"]')!;
    await fill(freshDialog.querySelector('input[aria-label="Reason"]')!, "New operator intent");
    const readsBeforeReceipt = reads.length;
    await act(async () => resolveDisable(Response.json({ ok: true, data: {} })));
    expect(new URLSearchParams(window.location.search).get("promoSearch")).toBe("query-b");
    expect(reads).toHaveLength(readsBeforeReceipt);
    expect(document.body.textContent).not.toContain("Redeem code code-one disabled");
    expect(document.querySelector('[role="dialog"]')).toBe(freshDialog);
    expect(freshDialog.querySelector<HTMLInputElement>('input[aria-label="Reason"]')!.value).toBe("New operator intent");
    expect(writes).toHaveLength(1);
  });

  it("retains a current disable intent and idempotency key for explicit retry after an unknown outcome", async () => {
    window.history.replaceState(null, "", "/admin/growth/offers?view=promo");
    const writes: Array<{ body: unknown; key: string | null }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input), window.location.origin).pathname;
      if (init?.method === "POST") {
        writes.push({ body: JSON.parse(String(init.body)), key: new Headers(init.headers).get("idempotency-key") });
        return writes.length === 1
          ? Response.json({ ok: false, error: { code: "authority_unavailable", message: "Response was lost", requestId: "promo-unknown" } }, { status: 503 })
          : Response.json({ ok: true, data: {} });
      }
      const items = path.endsWith("/redeem-codes")
        ? [{ id: "code-one", status: "active", reward: { dreamcoins: 100 }, maxRedemptions: 3, redemptions: 1 }]
        : [];
      return Response.json({ ok: true, data: { items, pageInfo: { endCursor: null, hasNextPage: false } } });
    }));
    await act(async () => root.render(<AdminI18nProvider locale="en"><PromoWorkspace canWrite /></AdminI18nProvider>));
    await act(async () => [...container.querySelectorAll("button")].find((node) => node.textContent?.trim() === "Disable")!.click());
    const dialog = document.querySelector('[role="dialog"]')!;
    const reason = dialog.querySelector<HTMLInputElement>('input[aria-label="Reason"]')!;
    const confirmation = dialog.querySelector<HTMLInputElement>('input[aria-label="Confirmation"]')!;
    for (const [input, next] of [[reason, "Confirmed operator intent"], [confirmation, "code-one"]] as const) {
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, next);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    }
    const submit = [...dialog.querySelectorAll("button")].find((node) => node.textContent?.trim() === "Disable")!;
    await act(async () => submit.click());
    expect(writes).toHaveLength(1);
    expect(dialog.querySelector('[role="alert"]')).not.toBeNull();
    expect(document.querySelector('[role="dialog"]')).toBe(dialog);
    expect(reason.value).toBe("Confirmed operator intent");
    expect(confirmation.value).toBe("code-one");
    expect(submit.disabled).toBe(false);
    await act(async () => submit.click());
    expect(writes).toHaveLength(2);
    expect(writes[0]?.key).toBeTruthy();
    expect(writes[1]).toEqual(writes[0]);
    expect(writes[1]?.body).toEqual({ reason: "Confirmed operator intent", confirmation: "code-one" });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("keeps a new history query when disable succeeds with unchanged write permission", async () => {
    window.history.replaceState(null, "", "/admin/growth/offers?view=promo&promoSearch=query-a");
    let resolveDisable!: (response: Response) => void;
    const pendingDisable = new Promise<Response>((resolve) => { resolveDisable = resolve; });
    const reads: URL[] = [];
    const writes: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input), window.location.origin);
      if (init?.method === "POST") {
        writes.push(url.pathname);
        return pendingDisable;
      }
      reads.push(url);
      const items = url.pathname.endsWith("/redeem-codes")
        ? [{ id: url.searchParams.get("search") === "query-b" ? "code-two" : "code-one", status: "active", reward: { dreamcoins: 100 }, maxRedemptions: 3, redemptions: 1 }]
        : [];
      return Response.json({ ok: true, data: { items, pageInfo: { endCursor: null, hasNextPage: false } } });
    }));
    await act(async () => root.render(<AdminI18nProvider locale="en"><ToastProvider><PromoWorkspace canWrite /></ToastProvider></AdminI18nProvider>));
    await act(async () => [...container.querySelectorAll("button")].find((node) => node.textContent?.trim() === "Disable")!.click());
    const dialog = document.querySelector('[role="dialog"]')!;
    for (const [input, next] of [[dialog.querySelector<HTMLInputElement>('input[aria-label="Reason"]')!, "Authorized query-a intent"], [dialog.querySelector<HTMLInputElement>('input[aria-label="Confirmation"]')!, "code-one"]] as const) {
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, next);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    }
    await act(async () => [...dialog.querySelectorAll("button")].find((node) => node.textContent?.trim() === "Disable")!.click());
    expect(writes).toEqual(["/api/v2/admin/promo/redeem-codes/code-one/disable"]);
    await act(async () => {
      window.history.replaceState(null, "", "/admin/growth/offers?view=promo&promoSearch=query-b");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(new URLSearchParams(window.location.search).get("promoSearch")).toBe("query-b");
    expect(reads.at(-1)?.searchParams.get("search")).toBe("query-b");
    expect(container.textContent).toContain("code-two");
    const readsBeforeReceipt = reads.length;
    await act(async () => resolveDisable(Response.json({ ok: true, data: {} })));
    expect(new URLSearchParams(window.location.search).get("promoSearch")).toBe("query-b");
    expect(reads).toHaveLength(readsBeforeReceipt);
    expect(container.textContent).toContain("code-two");
    expect(document.body.textContent).not.toContain("Redeem code code-one disabled");
    expect(writes).toHaveLength(1);
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
