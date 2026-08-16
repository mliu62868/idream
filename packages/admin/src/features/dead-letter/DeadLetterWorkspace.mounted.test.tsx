// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { apiGet, apiWrite } = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiWrite: vi.fn(),
}));

vi.mock("@/components/admin/api", () => ({ apiGet, apiWrite }));

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

    await act(async () => {
      root.render(<DeadLetterWorkspace permissions={{ discard: true, requeue: true }} />);
    });
    await waitUntil(() => container.textContent?.includes(retryable.id) ?? false);

    expect(rowActions(container, retryable.id)).toContain("Requeue");
    // 状态同样是 failed，但权威判定 refunded → 不给 Requeue，并说明原因。
    expect(rowActions(container, alreadyRefunded.id)).not.toContain("Requeue");
    expect(container.textContent).toContain("The charge was already refunded");
    expect(container.textContent).toContain("Safe to requeue");
  });

  it("reports the authority's own requeue outcome instead of claiming the batch completed", async () => {
    apiGet.mockResolvedValue({ items: [retryable], pageInfo: { endCursor: null, hasNextPage: false } });
    apiWrite.mockResolvedValue({
      requeued: [],
      skipped: [{ id: retryable.id, reason: "successful_artifact_exists" }],
    });

    await act(async () => {
      root.render(<DeadLetterWorkspace permissions={{ discard: false, requeue: true }} />);
    });
    await waitUntil(() => container.textContent?.includes(retryable.id) ?? false);

    await click(container.querySelector<HTMLInputElement>(`input[aria-label="Select dead-letter job ${retryable.id}"]`));
    await click(findButton("Requeue selected", container));

    const dialog = await waitForDialog();
    await enter(dialog.querySelector<HTMLInputElement>('input[aria-label="Reason (≥3)"]'), "Provider recovered");
    await enter(dialog.querySelector<HTMLInputElement>('input[aria-label="Confirmation"]'), retryable.id);
    await click(findButton("Confirm", dialog));

    await waitUntil(() => apiWrite.mock.calls.length === 1);
    expect(apiWrite).toHaveBeenCalledWith(
      "/api/v2/admin/generation/dead-letter/commands/requeue",
      "POST",
      { jobIds: [retryable.id], reason: "Provider recovered", confirmation: retryable.id },
      { "idempotency-key": idempotencyKey },
    );
    await waitUntil(() => container.textContent?.includes("Requeued 0 of 1 requests.") ?? false);
    expect(container.textContent).toContain("A delivered artifact already exists");
  });
  it("reuses one idempotency key when the operator retries a failed command in place", async () => {
    // 确认框向运营承诺「就地重试不会重复执行」——那这条就必须是真的：
    // 幂等键在打开对话框时生成一次，失败后的重试走的是同一个闭包。
    // 让 randomUUID 每次都吐不同的值，否则这条断言会因为公共 mock 恒等而空过。
    let issued = 0;
    vi.spyOn(globalThis.crypto, "randomUUID").mockImplementation(
      () => `00000000-0000-4000-8000-00000000000${issued++}` as `${string}-${string}-${string}-${string}-${string}`,
    );
    apiGet.mockResolvedValue({ items: [retryable], pageInfo: { endCursor: null, hasNextPage: false } });
    apiWrite
      .mockRejectedValueOnce(new Error("Upstream authority is unavailable"))
      .mockResolvedValueOnce({ requeued: [retryable.id], skipped: [] });

    await act(async () => {
      root.render(<DeadLetterWorkspace permissions={{ discard: false, requeue: true }} />);
    });
    await waitUntil(() => container.textContent?.includes(retryable.id) ?? false);
    await click(container.querySelector<HTMLInputElement>(`input[aria-label="Select dead-letter job ${retryable.id}"]`));
    await click(findButton("Requeue selected", container));

    const dialog = await waitForDialog();
    await enter(dialog.querySelector<HTMLInputElement>('input[aria-label="Reason (≥3)"]'), "Provider recovered");
    await enter(dialog.querySelector<HTMLInputElement>('input[aria-label="Confirmation"]'), retryable.id);
    await click(findButton("Confirm", dialog));

    // 失败就地显示，对话框不关。
    await waitUntil(() => dialog.textContent?.includes("Upstream authority is unavailable") ?? false);
    await click(findButton("Confirm", dialog));
    await waitUntil(() => apiWrite.mock.calls.length === 2);

    const keys = apiWrite.mock.calls.map(([, , , headers]) => (headers as Record<string, string>)["idempotency-key"]);
    expect(keys[0]).toBe(keys[1]);
    // 两次提交只生成过一个键：不是 mock 恒等，是代码真的没有重新生成。
    expect(issued).toBe(1);
    await waitUntil(() => container.textContent?.includes("Requeued 1 of 1 requests.") ?? false);
  });
});

function rowActions(root: ParentNode, id: string) {
  const checkbox = root.querySelector(`input[aria-label="Select dead-letter job ${id}"]`);
  return checkbox?.closest("tr")?.textContent ?? "";
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
