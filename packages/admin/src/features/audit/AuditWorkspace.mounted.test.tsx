// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ADMIN_WORKSPACE_REFRESH_EVENT } from "@/features/workspace-refresh";

const { apiGet } = vi.hoisted(() => ({ apiGet: vi.fn<(path: string) => Promise<unknown>>() }));

vi.mock("@/components/admin/api", () => ({ apiGet, apiWrite: vi.fn(), apiDelete: vi.fn() }));

import { AuditWorkspace } from "./AuditWorkspace";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// 一次批量操作写出的四条同类记录 —— 折叠后只剩第一条可见。
const batchRun = ["a", "b", "c", "d"].map((suffix) => ({
  id: `audit-${suffix}`,
  action: "character.image_readiness.repaired",
  actorId: "system:editorial",
  actorRole: "system",
  reason: "Adopt the live editorial portrait as image-production input",
  targetType: "character_project",
  targetId: `project-${suffix}`,
  createdAt: "2026-08-20T01:00:00.000Z",
}));

async function waitUntil(predicate: () => boolean) {
  const deadline = Date.now() + 3_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for the audit workspace");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
}

describe("audit repeat collapsing and row selection", () => {
  let container: HTMLDivElement;
  let root: Root | null;

  beforeEach(() => {
    apiGet.mockReset();
    apiGet.mockResolvedValue({ items: batchRun, pageInfo: { endCursor: null, hasNextPage: false } });
    window.history.replaceState(null, "", "/admin/audit-log");
    container = document.createElement("div");
    document.body.append(container);
    root = null;
  });

  afterEach(async () => {
    await act(async () => root?.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  function clickButton(label: string) {
    const button = [...container.querySelectorAll("button")].find(
      (candidate) => candidate.textContent?.trim() === label,
    );
    if (!button) throw new Error(`Button not found: ${label}`);
    return act(async () => button.click());
  }

  function checkboxes() {
    return [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].filter(
      (input) => input.getAttribute("aria-label")?.startsWith("Select row "),
    );
  }

  async function mounted() {
    await act(async () => {
      root = createRoot(container);
      root.render(<AuditWorkspace />);
    });
    await waitUntil(() => checkboxes().length > 0);
  }

  it("reloads the applied audit scope through shell refresh and retains its unfinished search", async () => {
    await mounted();
    const input = container.querySelector<HTMLInputElement>('input[placeholder="action, target, reason, or request"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Unfinished audit search");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const applied = apiGet.mock.calls.at(-1)![0];
    const before = apiGet.mock.calls.length;
    const href = window.location.href;
    await act(async () => { window.dispatchEvent(new Event(ADMIN_WORKSPACE_REFRESH_EVENT)); });
    expect(apiGet.mock.calls).toHaveLength(before + 1);
    expect(apiGet.mock.calls.at(-1)![0]).toBe(applied);
    expect(input.value).toBe("Unfinished audit search");
    expect(window.location.href).toBe(href);
  });

  // SPEC: 折叠默认开着，四条同类只显示第一条。
  it("shows one row per run and says how many it hid", async () => {
    await mounted();

    expect(checkboxes()).toHaveLength(1);
    expect(container.textContent).toContain("3 repeats of the row above are hidden");
  });

  // SPEC: 折起来的行必须同时退出勾选。
  // INTENT: DataTable 的「全选」只作用于可见行，所以"展开 → 全选 → 折叠"之后 selectedRows 里
  //         留着三条屏幕上已经看不见的 ID，选择条会说「4 selected」而只有一个框是勾的，
  //         「复制选中 ID」跟着复制到运营从没看过的行。审计日志上这是硬伤。
  it("drops rows from the selection when collapsing hides them", async () => {
    await mounted();
    await clickButton("Show every row");
    expect(checkboxes()).toHaveLength(4);

    const selectAll = [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
      .find((input) => input.getAttribute("aria-label") === "Select all rows on this page");
    if (!selectAll) throw new Error("Select-all checkbox is missing");
    await act(async () => selectAll.click());
    expect(container.textContent).toContain("4 selected");

    await clickButton("Hide repeats");

    expect(checkboxes()).toHaveLength(1);
    expect(container.textContent).toContain("1 selected");
    expect(container.textContent).not.toContain("4 selected");
  });

  it("makes the recorded before/after snapshots and request ID available without loading unredacted source objects", async () => {
    apiGet.mockResolvedValue({
      items: [{
        ...batchRun[0],
        requestId: "request-recipe-update-1",
        before: { label: "Previous recipe label", body: "[redacted]" },
        after: { label: "Updated recipe label", body: "[redacted]" },
      }],
      pageInfo: { endCursor: null, hasNextPage: false },
    });
    await mounted();
    const details = container.querySelector<HTMLDetailsElement>("details");
    expect(details).not.toBeNull();
    expect(details?.open).toBe(false);
    await act(async () => { details!.open = true; });
    expect(details?.textContent).toContain("Before change");
    expect(details?.textContent).toContain("After change");
    expect(details?.textContent).toContain("Previous recipe label");
    expect(details?.textContent).toContain("Updated recipe label");
    expect(details?.querySelector('[title="request-recipe-update-1"]')).not.toBeNull();
    expect(details?.textContent).toContain("[redacted]");
    expect(apiGet.mock.calls).toHaveLength(1);
    expect(apiGet.mock.calls[0][0]).toContain("/api/v2/admin/audit-log");
  });

  it("opens the linked failed command with its authoritative failure and Release blockers", async () => {
    window.history.replaceState(null, "", "/admin/system/audit?commandId=failed-resume");
    apiGet.mockImplementation(async (path) => path === "/api/v2/admin/commands/failed-resume" ? {
      commandId: "failed-resume", commandType: "character.serving.resume", target: { type: "character_serving", id: "paused-character" },
      requestId: "resume-request", createdAt: "2026-10-02T14:53:30.000Z",
      status: "failed", verificationState: "failed", needsReconciliation: false, updatedAt: "2026-10-02T14:53:30.000Z",
      error: { code: "serving_resume_validation_failed", message: "Current Release failed validation", validationRunId: "failed-validation",
        servingState: "paused",
        blockers: ["release_assets_customer_publishable", "release_asset_source_authority", "release_asset_generation_authority"] },
    } : { items: batchRun, pageInfo: { endCursor: null, hasNextPage: false } });
    await mounted();
    await waitUntil(() => container.querySelector('[title="failed-resume"]') !== null);
    const evidence = [...container.querySelectorAll<HTMLDetailsElement>("details")].find(
      (details) => details.querySelector("summary")?.textContent === "Command evidence",
    );
    expect(evidence).toBeDefined();
    expect(evidence?.open).toBe(false);
    await act(async () => { evidence!.open = true; });
    for (const fact of ["serving_resume_validation_failed", "failed-validation", "paused", "release_assets_customer_publishable",
      "release_asset_source_authority", "release_asset_generation_authority"]) expect(evidence?.textContent).toContain(fact);
    expect(apiGet.mock.calls.map(([path]) => path).sort()).toEqual([
      "/api/v2/admin/audit-log?commandId=failed-resume&limit=25",
      "/api/v2/admin/commands/failed-resume",
    ].sort());
  });
});
