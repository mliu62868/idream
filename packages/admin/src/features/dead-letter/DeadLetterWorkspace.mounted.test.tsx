// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { apiGet, apiWrite } = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiWrite: vi.fn(),
}));

vi.mock("@/lib/admin-v2-api", async (importOriginal) => {
  const { adminV2ContractFixtures } = await import("@idream/shared/admin/testing/contract-fixtures");
  const list = adminV2ContractFixtures("generationDeadLetterListResponseSchema").valid as object;
  return {
    ...await importOriginal<typeof import("@/lib/admin-v2-api")>(),
    adminV2Request: vi.fn(async (path: string, options: { method?: string; body?: unknown; schema?: { parse(value: unknown): unknown } } = {}) => {
      const result = !options.method || options.method === "GET"
        ? { ...list, ...await apiGet(path) }
        : await apiWrite(path, options.method, options.body);
      return options.schema ? options.schema.parse(result) : result;
    }),
  };
});

import { adminV2Request } from "@/lib/admin-v2-api";

import { ToastProvider } from "@/components/admin/ui/Toast";
import { DeadLetterWorkspace } from "./DeadLetterWorkspace";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const retryable = {
  id: "job-retryable",
  userId: "user-1",
  mode: "image",
  status: "failed",
  provider: "comfyui",
  errorCode: "timeout",
  costDreamcoins: 12,
  ledgerState: "reserved",
  retryEligibility: { eligible: true, reason: "retryable_failure" },
  createdAt: "2026-08-11T12:00:00.000Z",
  updatedAt: "2026-08-11T12:30:00.000Z",
};
const alreadyRefunded = {
  ...retryable,
  id: "job-refunded",
  ledgerState: "refunded",
  retryEligibility: { eligible: false, reason: "refunded" },
};
const idempotencyKey = "22222222-2222-4222-8222-222222222222";

describe("DeadLetterWorkspace retry authority", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    window.history.replaceState(null, "", "/admin/ops/jobs?view=dead-letter");
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    vi.mocked(adminV2Request).mockClear();
    apiGet.mockReset();
    apiWrite.mockReset();
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(idempotencyKey);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it("offers Requeue only where the authority says the request is retryable", async () => {
    apiGet.mockResolvedValue({ items: [retryable, alreadyRefunded], pageInfo: { endCursor: null, hasNextPage: false } });

    await render({ discard: true, requeue: true });
    await waitUntil(() => container.textContent?.includes(retryable.id) ?? false);

    expect(rowActions(container, retryable.id)).toContain("Requeue");
    // 状态同样是 failed，但权威判定 refunded → 不给 Requeue，并说明原因。
    expect(rowActions(container, alreadyRefunded.id)).not.toContain("Requeue");
    expect(container.textContent).toContain("The charge was already refunded");
    expect(container.textContent).toContain("Safe to requeue");
  });

  it("rejects a list without an authoritative retry verdict instead of inferring from failed status", async () => {
    apiGet.mockResolvedValue({ items: [{ ...retryable, retryEligibility: undefined }] });
    await render({ discard: true, requeue: true });
    await waitUntil(() => container.textContent?.includes("unavailable") ?? false);
    expect(container.textContent).not.toContain("Safe to requeue");
    expect(container.querySelector(`a[href*="job=${retryable.id}"]`)).toBeNull();
  });

  it("hides old write targets while a different query is pending or fails", async () => {
    let reject!: (error: Error) => void;
    apiGet.mockResolvedValueOnce({ items: [retryable] })
      .mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }));
    await render({ discard: true, requeue: true });
    await waitUntil(() => container.textContent?.includes(retryable.id) ?? false);
    await act(async () => {
      window.history.pushState(null, "", "/admin/ops/jobs?view=dead-letter&deadSearch=other");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(container.querySelector(`a[href*="job=${retryable.id}"]`)).toBeNull();
    await act(async () => reject(new Error("New query unavailable")));
    await waitUntil(() => container.textContent?.includes("New query unavailable") ?? false);
    expect(container.querySelector(`a[href*="job=${retryable.id}"]`)).toBeNull();
    expect(apiWrite).not.toHaveBeenCalled();
  });

  it("does not refresh the old query or clear the new selection after a late command completes", async () => {
    const next = { ...retryable, id: "job-next" };
    let resolve!: (value: unknown) => void;
    apiGet.mockImplementation((path: string) => Promise.resolve({ items: [path.includes("search=other") ? next : retryable] }));
    apiWrite.mockImplementation(() => new Promise((done) => { resolve = done; }));
    await render({ discard: false, requeue: true });
    await waitUntil(() => container.textContent?.includes(retryable.id) ?? false);
    await click(rowCheckbox(container, retryable.id));
    await click(findButton("Requeue selected", container));
    const dialog = await waitForDialog();
    await enter(dialog.querySelector<HTMLInputElement>('input[aria-label="Reason (≥3)"]'), "Provider recovered");
    await enter(dialog.querySelector<HTMLInputElement>('input[aria-label="Confirmation"]'), retryable.id);
    await click(findButton("Confirm", dialog));
    await waitUntil(() => apiWrite.mock.calls.length === 1);
    await act(async () => {
      window.history.pushState(null, "", "/admin/ops/jobs?view=dead-letter&deadSearch=other");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await waitUntil(() => container.textContent?.includes(next.id) ?? false);
    await click(rowCheckbox(container, next.id));
    await click(findButton("Requeue selected", container));
    const nextDialog = await waitForDialog();
    await act(async () => resolve({ requeued: [retryable.id], skipped: [] }));
    expect(apiGet).toHaveBeenCalledTimes(2);
    expect(rowCheckbox(container, next.id)?.checked).toBe(true);
    expect(window.location.search).toContain("deadSearch=other");
    expect(document.querySelector('[role="dialog"]')).toBe(nextDialog);
    expect(container.querySelector(`a[href*="job=${retryable.id}"]`)).toBeNull();
  });

  // SPEC: 手机端的危险动作前必须先显示本次判断所需的上下文，不能只留下 Job 与按钮。
  it("puts failure, replay, ledger, and cost context before mobile actions", async () => {
    apiGet.mockResolvedValue({ items: [retryable], pageInfo: { endCursor: null, hasNextPage: false } });

    await render({ discard: true, requeue: true });
    await waitUntil(() => container.textContent?.includes(retryable.id) ?? false);

    const mobileList = container.querySelector<HTMLElement>('.sm\\:hidden[aria-label="Dead-letter Queue"]');
    expect(mobileList).not.toBeNull();
    expect(mobileList?.className).toContain("sm:hidden");
    expect(mobileList?.textContent).toContain("Failure reason");
    expect(mobileList?.textContent).toContain("Replay authority");
    expect(mobileList?.textContent).toContain("Ledger");
    expect(mobileList?.textContent).toContain("Cost");
    expect(mobileList?.textContent?.indexOf("Cost")).toBeLessThan(
      mobileList?.textContent?.indexOf("Requeue") ?? -1,
    );
  });

  it("reports the authority's own requeue outcome instead of claiming the batch completed", async () => {
    apiGet.mockResolvedValue({ items: [retryable], pageInfo: { endCursor: null, hasNextPage: false } });
    apiWrite.mockResolvedValue({
      requeued: [],
      skipped: [{ id: retryable.id, reason: "successful_artifact_exists" }],
    });

    await render({ discard: false, requeue: true });
    await waitUntil(() => container.textContent?.includes(retryable.id) ?? false);

    await click(rowCheckbox(container, retryable.id));
    await click(findButton("Requeue selected", container));

    const dialog = await waitForDialog();
    // 后果横幅是不可撤销动作的常驻红条，不是 summary 里的一句话。
    expect(dialog.textContent).toContain("This cannot be undone.");
    expect(dialog.textContent).toContain("re-enter the generation queue");
    await enter(dialog.querySelector<HTMLInputElement>('input[aria-label="Reason (≥3)"]'), "Provider recovered");
    await enter(dialog.querySelector<HTMLInputElement>('input[aria-label="Confirmation"]'), retryable.id);
    await click(findButton("Confirm", dialog));

    await waitUntil(() => apiWrite.mock.calls.length === 1);
    expect(apiWrite).toHaveBeenCalledWith(
      "/api/v2/admin/generation/dead-letter/commands/requeue",
      "POST",
      { jobIds: [retryable.id], reason: "Provider recovered", confirmation: retryable.id },
    );
    // 结果落在 toast 里（挂在 document.body 上），不再是表格上方那条会滚出视口的横幅。
    await waitUntil(() => document.body.textContent?.includes("Requeued 0 of 1 requests.") ?? false);
    expect(document.body.textContent).toContain("A delivered artifact already exists");
    // 有跳过 → error 语气，因为 error toast 不会自己消失。
    expect(document.querySelector('[data-testid="admin-action-status"]')?.getAttribute("data-tone")).toBe("error");
  });

  it("selects every row from the table header and scopes each bulk command to what the authority allows", async () => {
    apiGet.mockResolvedValue({ items: [retryable, alreadyRefunded], pageInfo: { endCursor: null, hasNextPage: false } });

    await render({ discard: true, requeue: true });
    await waitUntil(() => container.textContent?.includes(alreadyRefunded.id) ?? false);

    await click(container.querySelector<HTMLInputElement>('input[aria-label="Select all rows on this page"]'));
    expect(rowCheckbox(container, retryable.id)?.checked).toBe(true);
    expect(rowCheckbox(container, alreadyRefunded.id)?.checked).toBe(true);
    expect(container.textContent).toContain("2 selected");
    // 权威说 refunded 那条不能重放，批量重放就只带走 1 条；作废两条都收得下。
    expect(findButton("Requeue selected", container)?.textContent).toContain("(1)");
    expect(findButton("Discard selected", container)?.textContent).toContain("(2)");

    await click(findButton("Clear selection", container));
    expect(container.textContent).not.toContain("2 selected");
    expect(rowCheckbox(container, retryable.id)?.checked).toBe(false);
  });
  it("reuses the operation ledger key when retrying an unacknowledged command", async () => {
    // Let every mint differ, then prove that a lost acknowledgement reuses one key.
    let issued = 0;
    vi.spyOn(globalThis.crypto, "randomUUID").mockImplementation(
      () => `00000000-0000-4000-8000-00000000000${issued++}` as `${string}-${string}-${string}-${string}-${string}`,
    );
    apiGet.mockResolvedValue({ items: [retryable], pageInfo: { endCursor: null, hasNextPage: false } });
    apiWrite
      .mockRejectedValueOnce(new Error("Upstream authority is unavailable"))
      .mockResolvedValueOnce({ requeued: [retryable.id], skipped: [] });

    await render({ discard: false, requeue: true });
    await waitUntil(() => container.textContent?.includes(retryable.id) ?? false);
    await click(rowCheckbox(container, retryable.id));
    await click(findButton("Requeue selected", container));

    const dialog = await waitForDialog();
    await enter(dialog.querySelector<HTMLInputElement>('input[aria-label="Reason (≥3)"]'), "Provider recovered");
    await enter(dialog.querySelector<HTMLInputElement>('input[aria-label="Confirmation"]'), retryable.id);
    await click(findButton("Confirm", dialog));

    // 失败就地显示，对话框不关。
    await waitUntil(() => dialog.textContent?.includes("Upstream authority is unavailable") ?? false);
    await click(findButton("Confirm", dialog));
    await waitUntil(() => apiWrite.mock.calls.length === 2);

    expect(issued).toBe(1);
    const writes = vi.mocked(adminV2Request).mock.calls.filter(([, options]) => options?.method === "POST");
    expect(writes).toHaveLength(2);
    expect(writes[0]?.[1]?.idempotencyKey).toBeTruthy();
    expect(writes[1]?.[1]?.idempotencyKey).toBe(writes[0]?.[1]?.idempotencyKey);
    await waitUntil(() => document.body.textContent?.includes("Requeued 1 of 1 requests.") ?? false);
  });

  async function render(permissions: { discard: boolean; requeue: boolean }) {
    await act(async () => {
      root.render(
        <ToastProvider>
          <DeadLetterWorkspace permissions={permissions} />
        </ToastProvider>,
      );
    });
  }
});

function rowCheckbox(root: ParentNode, id: string) {
  return root.querySelector<HTMLInputElement>(`input[aria-label="Select row ${id}"]`);
}

function rowActions(root: ParentNode, id: string) {
  return rowCheckbox(root, id)?.closest("tr")?.textContent ?? "";
}

function findButton(label: string, root: ParentNode = document) {
  return (
    [...root.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) =>
        button.getAttribute("aria-label") === label ||
        button.textContent?.trim().startsWith(label),
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
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function waitForDialog() {
  await waitUntil(() => document.querySelector('[role="dialog"]') !== null);
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
  if (!dialog) throw new Error("Dead-letter confirmation dialog did not mount");
  return dialog;
}

async function waitUntil(predicate: () => boolean) {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for DeadLetterWorkspace state");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}
