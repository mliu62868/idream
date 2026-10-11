// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { apiGet, apiWrite } = vi.hoisted(() => ({
  apiGet: vi.fn<(path: string) => Promise<unknown>>(),
  apiWrite: vi.fn<
    (
      path: string,
      method: "POST" | "PATCH" | "PUT",
      body: Record<string, unknown>,
      headers?: Record<string, string>,
    ) => Promise<unknown>
  >(),
}));

vi.mock("@/components/admin/api", () => ({ apiGet, apiWrite }));

import { ToastProvider } from "@/components/admin/ui/Toast";
import { AdminI18nProvider } from "@/components/admin/i18n";
import { AdminV2RequestError } from "@/lib/admin-v2-api";
import { ApprovalsWorkspace } from "./ApprovalsWorkspace";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const approvalId = "approval-1";
const idempotencyKey = "22222222-2222-4222-8222-222222222222";
const pendingApproval = {
  id: approvalId,
  action: "credit.adjust",
  permissionKey: "billing.ledger.write",
  targetType: "user",
  targetId: "user-7",
  requestedById: "operator-a",
  approvedById: null,
  reason: "Goodwill credit for the failed batch",
  payload: { delta: 1_000_000, currency: "DC" },
  status: "pending",
  createdAt: "2026-08-14T09:00:00.000Z",
  decidedAt: null,
};

describe("ApprovalsWorkspace decision evidence", () => {
  let container: HTMLDivElement;
  let root: Root;
  let reads: number;

  beforeEach(() => {
    window.history.replaceState(null, "", "/admin/system/approvals");
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    reads = 0;
    apiGet.mockReset();
    apiWrite.mockReset();
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(idempotencyKey);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  async function mount(items: unknown[], options: { canToggleEnforcement?: boolean; enforcementEnabled?: boolean; canReview?: boolean; locale?: "zh" | "en" } = {}) {
    apiGet.mockImplementation(async () => {
      reads += 1;
      return { items, pageInfo: { endCursor: null, hasNextPage: false }, enforcementEnabled: options.enforcementEnabled };
    });
    await act(async () => {
      root.render(
        <AdminI18nProvider locale={options.locale ?? "en"}><ToastProvider>
          <ApprovalsWorkspace canReview={options.canReview ?? true} canToggleEnforcement={options.canToggleEnforcement} />
        </ToastProvider></AdminI18nProvider>,
      );
    });
    await waitUntil(() => reads >= 1 && container.textContent !== "");
  }

  // 这是双人确认的整个意义所在：第二个人要挡住的是「动作对、参数错」。
  it("shows the requested parameters in the row and again inside the confirmation", async () => {
    await mount([pendingApproval]);
    await waitUntil(() => container.textContent?.includes(approvalId) === true);

    const details = container.querySelector('details[aria-label="Parameters"]');
    expect(details?.textContent).toContain("2 parameters");
    expect(details?.textContent).toContain("delta");
    expect(details?.textContent).toContain("1000000");
    expect(container.textContent).toContain("Awaiting decision");

    await click(findButton("Approve", container));
    const dialog = await waitForDialog();
    // 参数在弹窗里不折叠——可以选择不展开列表，但不能没看见参数就走完确认。
    expect(dialog.querySelector("details")).toBeNull();
    expect(dialog.textContent).toContain("credit.adjust");
    expect(dialog.textContent).toContain("user-7");
    expect(dialog.textContent).toContain("billing.ledger.write");
    expect(dialog.textContent).toContain("operator-a");
    expect(dialog.textContent).toContain("Goodwill credit for the failed batch");
    expect(dialog.textContent).toContain("delta");
    expect(dialog.textContent).toContain("1000000");
    expect(dialog.textContent).toContain("This cannot be undone.");
  });

  it("labels known actions and links supported targets without fabricating unknown routes", async () => {
    await mount([
      { ...pendingApproval, action: "billing.ledger.adjust" },
      { ...pendingApproval, id: "pricing-request", action: "config.pricing.publish", targetType: "pricing_rule", targetId: "rule/2" },
      { ...pendingApproval, id: "offer-request", action: "config.coin_offer.publish", targetType: "coin_offer" },
      { ...pendingApproval, id: "unknown-request", action: "future.operation", targetType: "future_target", targetId: "unknown-target" },
    ]);
    expect(container.textContent).toContain("Adjust Ledger");
    expect(container.textContent).toContain("1000000 Dreamcoins");
    expect(container.textContent).toContain("Publish pricing rule");
    expect(container.textContent).toContain("Publish coin offer");
    expect(container.textContent).toContain("future.operation");
    expect(container.querySelector('a[href="/admin/customers/user-7"]')).not.toBeNull();
    expect(container.querySelector('a[href="/admin/growth/offers?view=pricing&pricingSearch=rule%2F2"]')).not.toBeNull();
    expect([...container.querySelectorAll("a")].some(a => a.href.includes("unknown-target"))).toBe(false);
    const technical = [...container.querySelectorAll("details")].find(detail => detail.querySelector("summary")?.textContent === "Engineering details");
    expect(technical?.textContent).toContain("billing.ledger.adjust");
    expect(technical?.textContent).toContain("billing.ledger.write");
  });

  it("says so plainly when a request carries no parameters and no reason", async () => {
    await mount([
      { ...pendingApproval, payload: {}, reason: null },
    ]);
    await waitUntil(() => container.textContent?.includes(approvalId) === true);

    expect(container.textContent).toContain("No parameters");
    expect(container.querySelector('details[aria-label="Parameters"]')).toBeNull();

    await click(findButton("Approve", container));
    const dialog = await waitForDialog();
    expect(dialog.textContent).toContain("No parameters");
    expect(dialog.textContent).toContain("No reason given");
  });

  it("records who decided a request once it leaves the pending queue", async () => {
    await mount([
      {
        ...pendingApproval,
        approvedById: "operator-b",
        status: "approved",
        decidedAt: "2026-08-15T10:00:00.000Z",
      },
    ]);
    await waitUntil(() => container.textContent?.includes(approvalId) === true);

    expect(container.textContent).toContain("operator-b");
    expect(container.querySelector("tbody")?.textContent).toContain("approved");
    expect(container.textContent).not.toContain("Awaiting decision");
    expect(findButton("Approve", container)).toBeNull();
  });

  it.each(["en", "zh"] as const)("explains legacy approval recovery in %s and returns to the live action without cloning payload", async locale => {
    await mount([{ ...pendingApproval, action: "billing.ledger.adjust", permissionKey: "billing.ledger.adjust" }], { locale });
    apiWrite.mockRejectedValue(new AdminV2RequestError("Approval is unbound, expired, or invalid; request a new approval", 403, "forbidden", { recovery: "request_new_approval", action: "billing.ledger.adjust", targetId: "user-7" }));
    await click(findButton(locale === "zh" ? "通过" : "Approve", container));
    const dialog = await waitForDialog();
    const inputs = dialog.querySelectorAll<HTMLInputElement>("input");
    await enter(inputs[0]!, "Review the exact current adjustment");
    await enter(inputs[1]!, approvalId);
    await click(findButton(locale === "zh" ? "确认" : "Confirm", dialog));
    await waitUntil(() => dialog.querySelector('[role="alert"]') !== null);
    expect(dialog.textContent).toContain(locale === "zh" ? "此审批需要重新申请。" : "This approval must be requested again.");
    expect(dialog.textContent).not.toContain("Your account does not hold the permission");
    const link = dialog.querySelector<HTMLAnchorElement>('a[href="/admin/customer-ops/billing?billingView=ledger&billingSearch=user-7#billing-adjustment-title"]');
    expect(link).not.toBeNull();
    expect(link!.textContent).toBe(locale === "zh" ? "返回原操作申请审批" : "Open action to request approval");
    expect(apiWrite.mock.calls).toEqual([[`/api/v2/admin/approvals/${approvalId}/approve`, "POST", { reason: "Review the exact current adjustment", confirmation: approvalId }]]);
    expect(container.textContent).toContain(approvalId);
    expect(container.textContent).not.toContain(locale === "zh" ? "已批准" : "Approved approval-1");
  });

  it("keeps all known original actions reachable on historical rows without granting review", async () => {
    const actions = [
      { action: "billing.ledger.adjust", targetType: "user", targetId: "user-7", href: "/admin/customer-ops/billing?billingView=ledger&billingSearch=user-7#billing-adjustment-title" },
      { action: "config.pricing.publish", targetType: "pricing_rule", targetId: "rule/7", href: "/admin/growth/offers?view=pricing&pricingSearch=rule%2F7" },
      { action: "config.coin_offer.publish", targetType: "coin_offer", targetId: "offer-7", href: "/admin/growth/offers?view=pricing#coin-offers" },
      { action: "promo.redeem_code.create", targetType: "redeem_code", targetId: "redeem_code", href: "/admin/growth/offers?view=promo" },
      { action: "config.feature_flag.write", targetType: "feature_flag", targetId: "dual_approval_enforced", href: "/admin/system/approvals#approval-enforcement" },
    ];
    await mount(actions.map((entry, index) => ({ ...pendingApproval, ...entry, id: `historic-${index}`, status: index % 2 ? "rejected" : "approved" })), { canReview: false });
    for (const entry of actions) expect([...container.querySelectorAll("a")].some(link => link.getAttribute("href") === entry.href && link.textContent === "Open action to request approval")).toBe(true);
    expect(findButton("Approve", container)).toBeNull();
    expect(findButton("Reject", container)).toBeNull();
    expect(apiWrite).not.toHaveBeenCalled();
  });

  it("does not call a canceled request awaiting a decision", async () => {
    await mount([{ ...pendingApproval, status: "canceled" }]);
    expect(container.querySelector("tbody")?.textContent).toContain("canceled");
    expect(container.textContent).not.toContain("Awaiting decision");
    expect(findButton("Approve", container)).toBeNull();
  });

  it("offers a way out of a filter that matched nothing", async () => {
    window.history.replaceState(
      null,
      "",
      "/admin/system/approvals?approvalStatus=rejected",
    );
    await mount([]);
    await waitUntil(() => reads >= 1);

    const clear = findButton("Show pending approvals", container);
    expect(clear).not.toBeNull();
    await click(clear);
    await waitUntil(() => reads >= 2);
    expect(apiGet.mock.calls.at(-1)?.[0]).toContain("status=pending");
  });

  // SPEC: dual_approval_enforced 不在库里时，审批台是唯一能打开它的地方（PATCH upsert）。
  it("turns dual approval on through the feature flag upsert with confirmation", async () => {
    await mount([], { canToggleEnforcement: true, enforcementEnabled: false });
    apiWrite.mockResolvedValue({ flag: { key: "dual_approval_enforced", enabled: true } });
    await click(findButton("Turn on dual approval", container));
    const dialog = await waitForDialog();
    await enter(dialog.querySelector<HTMLInputElement>('input[aria-label="Reason"]'), "Enable two-person rule");
    await enter(dialog.querySelector<HTMLInputElement>('input[aria-label="Confirmation"]'), "dual_approval_enforced");
    await click(findButton("Confirm", dialog));
    await waitUntil(() => apiWrite.mock.calls.length === 1);
    expect(apiWrite).toHaveBeenCalledWith("/api/v2/admin/feature-flags/dual_approval_enforced", "PATCH", {
      enabled: true,
      reason: "Enable two-person rule",
      confirmation: "dual_approval_enforced:enabled",
    });
  });

  it("hides the dual approval switch without feature flag write access", async () => {
    await mount([], { enforcementEnabled: false });
    expect(findButton("Turn on dual approval", container)).toBeNull();
  });

  it("sends the decision with its confirmation and reports success", async () => {
    await mount([pendingApproval]);
    await waitUntil(() => container.textContent?.includes(approvalId) === true);
    apiWrite.mockResolvedValue({ request: { id: approvalId } });

    await click(findButton("Approve", container));
    const dialog = await waitForDialog();
    await enter(
      dialog.querySelector<HTMLInputElement>('input[aria-label="Reason"]'),
      "Second reviewer checked the delta",
    );
    await enter(
      dialog.querySelector<HTMLInputElement>('input[aria-label="Confirmation"]'),
      approvalId,
    );
    await click(findButton("Confirm", dialog));

    await waitUntil(() => apiWrite.mock.calls.length === 1);
    expect(apiWrite).toHaveBeenCalledWith(
      `/api/v2/admin/approvals/${approvalId}/approve`,
      "POST",
      { reason: "Second reviewer checked the delta", confirmation: approvalId },
    );
    await waitUntil(
      () =>
        document.body
          .querySelector('[data-testid="admin-action-status"]')
          ?.textContent?.includes(approvalId) === true,
    );
  });
});

function findButton(label: string, root: ParentNode = document) {
  return (
    [...root.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) =>
        button.getAttribute("aria-label") === label ||
        button.textContent?.trim() === label,
    ) ?? null
  );
}

async function click(element: HTMLElement | null) {
  expect(element).not.toBeNull();
  await act(async () => {
    element?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

async function enter(input: HTMLInputElement | null, value: string) {
  expect(input).not.toBeNull();
  await act(async () => {
    if (!input) return;
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function waitForDialog() {
  await waitUntil(() => document.querySelector('[role="dialog"]') !== null);
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
  if (!dialog) throw new Error("Approval confirmation dialog did not mount");
  return dialog;
}

async function waitUntil(predicate: () => boolean) {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for ApprovalsWorkspace state");
    }
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}
