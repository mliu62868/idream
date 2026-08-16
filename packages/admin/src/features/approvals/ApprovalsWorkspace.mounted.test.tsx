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

  async function mount(items: unknown[]) {
    apiGet.mockImplementation(async () => {
      reads += 1;
      return { items, pageInfo: { endCursor: null, hasNextPage: false } };
    });
    await act(async () => {
      root.render(
        <ToastProvider>
          <ApprovalsWorkspace canReview />
        </ToastProvider>,
      );
    });
    await waitUntil(() => reads >= 1 && container.textContent !== "");
  }

  // 这是双人确认的整个意义所在：第二个人要挡住的是「动作对、参数错」。
  it("shows the requested parameters in the row and again inside the confirmation", async () => {
    await mount([pendingApproval]);
    await waitUntil(() => container.textContent?.includes(approvalId) === true);

    const details = container.querySelector("details");
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

  it("says so plainly when a request carries no parameters and no reason", async () => {
    await mount([
      { ...pendingApproval, payload: {}, reason: null },
    ]);
    await waitUntil(() => container.textContent?.includes(approvalId) === true);

    expect(container.textContent).toContain("No parameters");
    expect(container.querySelector("details")).toBeNull();

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
    expect(container.textContent).not.toContain("Awaiting decision");
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
      { "idempotency-key": idempotencyKey },
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
