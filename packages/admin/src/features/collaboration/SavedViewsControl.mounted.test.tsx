// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OperationsCase, SavedView } from "@idream/shared/admin";
import { AdminI18nProvider } from "@/components/admin/i18n";
import { ToastProvider } from "@/components/admin/ui/Toast";
import { CaseWorkspace } from "@/features/cases/CaseWorkspace";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const viewA: SavedView = {
  id: "audit-view-a",
  scope: "case",
  label: "Audit view A",
  queryState: { search: "audit-A", filters: { view: "all" }, sort: { field: "updated_at", direction: "desc" }, pageSize: 30 },
  version: 3,
  createdAt: "2026-10-05T00:00:00.000Z",
  updatedAt: "2026-10-05T00:00:00.000Z",
};
const viewB: SavedView = { ...viewA, id: "audit-view-b", label: "Audit view B", queryState: { ...viewA.queryState, search: "audit-B" } };

function response(data: unknown, status = 200) {
  return new Response(JSON.stringify(status < 400 ? { ok: true, data } : { ok: false, error: data }), { status });
}

function setValue(input: HTMLInputElement | HTMLSelectElement, value: string) {
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")?.set?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

async function waitUntil(predicate: () => boolean) {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for Saved Views");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
}

describe("Saved Views through the Case workspace", () => {
  let container: HTMLDivElement;
  let root: Root;
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

  beforeEach(() => {
    window.history.replaceState(null, "", "/admin/cases?view=all&savedView=audit-view-a");
    fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  function caseList(path: string, items: OperationsCase[] = []) {
    const query = new URL(path, "http://admin.local").searchParams;
    return response({
      items, pageInfo: { endCursor: null, hasNextPage: false },
      asOf: "2026-10-05T00:00:00.000Z", freshness: "fresh",
      query: { view: query.get("view") ?? "all", cursor: null, limit: 30, sort: "updated_desc" },
    });
  }

  async function mount(locale: "en" | "zh" = "en") {
    await act(async () => root.render(<AdminI18nProvider locale={locale}><ToastProvider><CaseWorkspace canAssign canDecide /></ToastProvider></AdminI18nProvider>));
    await waitUntil(() => container.querySelector<HTMLSelectElement>("select")?.disabled === false);
  }

  function labelInput() {
    return container.querySelector<HTMLInputElement>('input[maxlength="80"]')!;
  }

  function overwriteButton() {
    return [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.startsWith("Overwrite v"))!;
  }

  function dialogOverwrite() {
    return [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((button) => button.textContent === "Overwrite")!;
  }

  it("shows the reloaded version before explicitly retrying a conflicted overwrite and preserves the operator's draft", async () => {
    let authorityView = viewA;
    const writes: Array<{ version: string | null; body: unknown }> = [];
    fetchMock.mockImplementation(async (input, init) => {
      const path = String(input);
      if (path.startsWith("/api/v2/admin/cases?")) return caseList(path);
      if (path === "/api/v2/admin/saved-views?scope=case") return response({ items: [authorityView] });
      if (path === `/api/v2/admin/saved-views/${viewA.id}` && init?.method === "PATCH") {
        const body = JSON.parse(String(init.body));
        writes.push({ version: new Headers(init.headers).get("if-match"), body });
        if (writes.length === 1) {
          authorityView = { ...viewA, version: 4, updatedAt: "2026-10-05T00:01:00.000Z" };
          return response({ code: "entity_version_conflict", message: "The saved view changed", requestId: "saved-view-conflict" }, 409);
        }
        if (new Headers(init.headers).get("if-match") !== '"4"' || body.expectedVersion !== 4) {
          return response({ code: "entity_version_conflict", message: "The saved view changed" }, 409);
        }
        authorityView = { ...authorityView, label: body.label, queryState: body.queryState, version: 5 };
        return response({ view: authorityView });
      }
      throw new Error(`Unexpected request ${init?.method ?? "GET"} ${path}`);
    });
    await mount();
    await waitUntil(() => labelInput().value === "Audit view A");
    await act(async () => setValue(labelInput(), "Audit renamed by operator"));
    await act(async () => overwriteButton().click());
    await act(async () => setValue(document.querySelector<HTMLInputElement>('input[aria-label="Saved view name"]')!, "Audit view A"));
    await act(async () => dialogOverwrite().click());
    await waitUntil(() => overwriteButton().textContent === "Overwrite v4");

    const refreshedConfirmation = document.querySelector('[role="dialog"]')?.textContent;
    const retainedDraft = labelInput().value;
    expect(writes).toHaveLength(1);
    expect(document.querySelector<HTMLInputElement>('input[aria-label="Saved view name"]')?.value).toBe("");
    expect(dialogOverwrite().disabled).toBe(true);
    await act(async () => setValue(document.querySelector<HTMLInputElement>('input[aria-label="Saved view name"]')!, "Audit view A"));
    await act(async () => dialogOverwrite().click());
    await waitUntil(() => writes.length === 2);
    expect(writes.map((write) => write.version)).toEqual(['"3"', '"4"']);
    expect(refreshedConfirmation).toContain("stored v4 query");
    expect(retainedDraft).toBe("Audit renamed by operator");
    await waitUntil(() => document.querySelector('[role="dialog"]') === null);
    expect(writes[1].body).toMatchObject({ expectedVersion: 4, label: "Audit renamed by operator" });
    expect(labelInput().value).toBe("Audit renamed by operator");
    expect(new URLSearchParams(window.location.search).get("savedView")).toBe(viewA.id);
  });

  it.each([
    ["an old label", [viewA, viewB]],
    ["a missing old selection", []],
  ])("keeps the selected B view and its operator draft when a browser-history A read returns %s late", async (_description, oldItems) => {
    let resolveOldRead!: (response: Response) => void;
    const oldRead = new Promise<Response>((resolve) => { resolveOldRead = resolve; });
    let delayNextRead = false;
    let oldReadStarted = false;
    fetchMock.mockImplementation(async (input) => {
      const path = String(input);
      if (path.startsWith("/api/v2/admin/cases?")) return caseList(path);
      if (path === "/api/v2/admin/saved-views?scope=case") {
        if (delayNextRead) {
          delayNextRead = false;
          oldReadStarted = true;
          return oldRead;
        }
        return response({ items: [viewA, viewB] });
      }
      throw new Error(`Unexpected request ${path}`);
    });
    await mount();
    await waitUntil(() => labelInput().value === "Audit view A");
    delayNextRead = true;
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Reload")!.click());
    await waitUntil(() => oldReadStarted);

    // SPEC: CaseWorkspace restores selectedId from Back/Forward while the control's select is disabled.
    await act(async () => {
      window.history.replaceState(null, "", "/admin/cases?view=all&savedView=audit-view-b");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await waitUntil(() => labelInput().value === "Audit view B");
    await act(async () => setValue(labelInput(), "Operator B draft"));
    await act(async () => { resolveOldRead(response({ items: oldItems })); await oldRead; });

    expect(labelInput().value).toBe("Operator B draft");
    expect(container.querySelector<HTMLSelectElement>("select")?.value).toBe(viewB.id);
    expect(new URLSearchParams(window.location.search).get("savedView")).toBe(viewB.id);
    await act(async () => overwriteButton().click());
    expect(document.querySelector<HTMLInputElement>('input[aria-label="Saved view name"]')?.placeholder).toContain("Audit view B");
  });

  it.each([
    ["en", "Overwrite Saved View", "Your saved view Audit view A will use this query.", "Your saved view is deleted. There is no recycle bin.", "Overwrite v", "Cancel", "Delete"],
    ["zh", "覆盖已保存视图", "你的已保存视图「Audit view A」将使用这份查询。", "你的已保存视图会被删除，后台没有回收站。", "覆盖 v", "取消", "删除"],
  ] as const)("describes only the current operator's private view in %s confirmations", async (locale, title, overwriteEffect, deleteEffect, overwritePrefix, cancelLabel, deleteLabel) => {
    fetchMock.mockImplementation(async (input) => {
      const path = String(input);
      if (path.startsWith("/api/v2/admin/cases?")) return caseList(path);
      if (path === "/api/v2/admin/saved-views?scope=case") return response({ items: [viewA] });
      throw new Error(`Unexpected request ${path}`);
    });
    await mount(locale);
    await waitUntil(() => labelInput().value === viewA.label);
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.startsWith(overwritePrefix))!.click());
    const overwriteCopy = document.querySelector('[role="dialog"]')?.textContent;
    expect(overwriteCopy).toContain(title);
    expect(overwriteCopy).toContain(overwriteEffect);
    expect(overwriteCopy).not.toMatch(/shared|Everyone|共享|所有人/);
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((button) => button.textContent === cancelLabel)!.click());
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === deleteLabel)!.click());
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(deleteEffect);
    expect(fetchMock.mock.calls.every(([, init]) => !init?.method || init.method === "GET")).toBe(true);
  });

  it.each(["selection", "query", "label"] as const)("does not apply an old Save new receipt after the operator changes the %s", async (change) => {
    let resolveCreate!: (response: Response) => void;
    const createResponse = new Promise<Response>((resolve) => { resolveCreate = resolve; });
    let writeStarted = false;
    let committed = false;
    const createdView: SavedView = { ...viewA, id: "new-view-from-a", label: "New view from A", version: 1 };
    fetchMock.mockImplementation(async (input, init) => {
      const path = String(input);
      if (path.startsWith("/api/v2/admin/cases?")) return caseList(path);
      if (path === "/api/v2/admin/saved-views?scope=case") return response({ items: committed ? [viewA, viewB, createdView] : [viewA, viewB] });
      if (path === "/api/v2/admin/saved-views" && init?.method === "POST") { writeStarted = true; return createResponse; }
      throw new Error(`Unexpected request ${init?.method ?? "GET"} ${path}`);
    });
    await mount();
    await waitUntil(() => labelInput().value === viewA.label);
    await act(async () => setValue(labelInput(), "New view from A"));
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Save new")!.click());
    await waitUntil(() => writeStarted);
    if (change === "selection") {
      const select = container.querySelector<HTMLSelectElement>("select")!;
      expect(select.disabled).toBe(false);
      await act(async () => setValue(select, viewB.id));
      await waitUntil(() => labelInput().value === viewB.label);
    } else if (change === "query") {
      await act(async () => setValue(container.querySelector<HTMLInputElement>('input[placeholder="Search all cases"]')!, "Audit changed query"));
      // Case draft editing keeps the same selected view, so selectedId alone cannot guard the receipt.
      expect(container.querySelector<HTMLSelectElement>("select")?.value).toBe(viewA.id);
    }
    expect(new URLSearchParams(window.location.search).get("savedView")).toBe(change === "selection" ? viewB.id : viewA.id);
    expect(labelInput().disabled).toBe(false);
    await act(async () => setValue(labelInput(), "Current operator draft"));
    await act(async () => {
      committed = true;
      resolveCreate(response({ view: createdView, duplicate: false }));
      await createResponse;
    });

    expect(labelInput().value).toBe("Current operator draft");
    expect(new URLSearchParams(window.location.search).get("savedView")).toBe(change === "selection" ? viewB.id : viewA.id);
    if (change === "query") expect(container.querySelector<HTMLInputElement>('input[placeholder="Search all cases"]')?.value).toBe("Audit changed query");
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it("applies a newly saved view when its Case context and label draft are unchanged", async () => {
    const createdView: SavedView = { ...viewA, id: "new-view-from-a", label: "New view from A", version: 1 };
    let committed = false;
    fetchMock.mockImplementation(async (input, init) => {
      const path = String(input);
      if (path.startsWith("/api/v2/admin/cases?")) return caseList(path);
      if (path === "/api/v2/admin/saved-views?scope=case") return response({ items: committed ? [viewA, createdView] : [viewA] });
      if (path === "/api/v2/admin/saved-views" && init?.method === "POST") {
        committed = true;
        return response({ view: createdView, duplicate: false });
      }
      throw new Error(`Unexpected request ${init?.method ?? "GET"} ${path}`);
    });
    await mount();
    await waitUntil(() => labelInput().value === viewA.label);
    await act(async () => setValue(labelInput(), createdView.label));
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Save new")!.click());
    await waitUntil(() => container.querySelector<HTMLSelectElement>("select")?.value === createdView.id);

    expect(labelInput().value).toBe(createdView.label);
    expect(new URLSearchParams(window.location.search).get("savedView")).toBe(createdView.id);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it.each(["PATCH", "DELETE"] as const)("keeps B selected after an old %s receipt completes following browser Back/Forward", async (method) => {
    let resolveWrite!: (response: Response) => void;
    const writeResponse = new Promise<Response>((resolve) => { resolveWrite = resolve; });
    let writeStarted = false;
    fetchMock.mockImplementation(async (input, init) => {
      const path = String(input);
      if (path.startsWith("/api/v2/admin/cases?")) return caseList(path);
      if (path === "/api/v2/admin/saved-views?scope=case") return response({ items: [viewA, viewB] });
      if (path === `/api/v2/admin/saved-views/${viewA.id}` && init?.method === method) { writeStarted = true; return writeResponse; }
      throw new Error(`Unexpected request ${init?.method ?? "GET"} ${path}`);
    });
    await mount();
    await waitUntil(() => labelInput().value === viewA.label);
    await act(async () => {
      if (method === "PATCH") overwriteButton().click();
      else [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Delete")!.click();
    });
    await act(async () => setValue(document.querySelector<HTMLInputElement>('input[aria-label="Saved view name"]')!, viewA.label));
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((button) => button.textContent === (method === "PATCH" ? "Overwrite" : "Delete saved view"))!.click());
    await waitUntil(() => writeStarted);
    await act(async () => {
      window.history.replaceState(null, "", "/admin/cases?view=all&search=audit-B&savedView=audit-view-b");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await waitUntil(() => labelInput().value === viewB.label);
    await act(async () => setValue(labelInput(), "Current B draft"));
    let newConfirmation: Element | null = null;
    if (method === "DELETE") {
      // DELETE belongs to the old dialog; its late onClose must not close a new B intent.
      await act(async () => overwriteButton().click());
      await act(async () => setValue(document.querySelector<HTMLInputElement>('input[aria-label="Saved view name"]')!, viewB.label));
      newConfirmation = document.querySelector('[role="dialog"]');
    }
    await act(async () => {
      resolveWrite(response(method === "PATCH" ? { view: { ...viewA, version: 4 } } : { deleted: true }));
      await writeResponse;
    });

    expect(new URLSearchParams(window.location.search).get("savedView")).toBe(viewB.id);
    expect(labelInput().value).toBe("Current B draft");
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === method)).toHaveLength(1);
    if (method === "DELETE") {
      expect(document.querySelector('[role="dialog"]')).toBe(newConfirmation);
      expect(document.querySelector<HTMLInputElement>('input[aria-label="Saved view name"]')?.value).toBe(viewB.label);
    }
  });

  it("refreshes the selected view version without replacing a label edited while Reload was pending", async () => {
    let resolveRead!: (response: Response) => void;
    const readResponse = new Promise<Response>((resolve) => { resolveRead = resolve; });
    let delayNextRead = false;
    let readStarted = false;
    fetchMock.mockImplementation(async (input) => {
      const path = String(input);
      if (path.startsWith("/api/v2/admin/cases?")) return caseList(path);
      if (path === "/api/v2/admin/saved-views?scope=case") {
        if (delayNextRead) { delayNextRead = false; readStarted = true; return readResponse; }
        return response({ items: [viewA] });
      }
      throw new Error(`Unexpected request ${path}`);
    });
    await mount();
    await waitUntil(() => labelInput().value === viewA.label);
    delayNextRead = true;
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Reload")!.click());
    await waitUntil(() => readStarted);
    expect(labelInput().disabled).toBe(false);
    await act(async () => setValue(labelInput(), "Operator label entered during refresh"));
    await act(async () => { resolveRead(response({ items: [{ ...viewA, version: 4 }] })); await readResponse; });
    await waitUntil(() => overwriteButton().textContent === "Overwrite v4");
    expect(labelInput().value).toBe("Operator label entered during refresh");
  });

  it("keeps the newly selected Case and URL after an old Save new receipt completes", async () => {
    const caseA: OperationsCase = {
      id: "case-a", type: "support_request", target: { type: "user", id: "audit-customer" },
      caseKey: "ticket:AUDIT-SAVEDVIEW-CASE-A", status: "new", priority: "normal", severity: "medium",
      ownerId: null, slaDueAt: "2026-10-06T00:00:00.000Z", reportCount: 1, messageCount: 0,
      resolutionSummary: null, verification: null, relatedIncidentIds: [], relatedCaseIds: [], version: 1,
      createdAt: "2026-10-05T00:00:00.000Z", updatedAt: "2026-10-05T00:00:00.000Z",
    };
    const caseB = { ...caseA, id: "case-b", caseKey: "ticket:AUDIT-SAVEDVIEW-CASE-B" };
    const createdView: SavedView = { ...viewA, id: "new-view-from-a", label: "New view from A", version: 1 };
    let resolveCreate!: (response: Response) => void;
    const createResponse = new Promise<Response>((resolve) => { resolveCreate = resolve; });
    let committed = false;
    let writeStarted = false;
    fetchMock.mockImplementation(async (input, init) => {
      const path = String(input);
      if (path.startsWith("/api/v2/admin/cases?")) return caseList(path, [caseA, caseB]);
      if (path === "/api/v2/admin/cases/case-a" || path === "/api/v2/admin/cases/case-b") {
        return response({ case: path.endsWith("case-a") ? caseA : caseB, evidence: [], decisions: [], activity: [] });
      }
      if (path.startsWith("/api/v2/admin/collaboration/case/")) return response({ items: [], actors: [], watching: false, watcherIds: [], pageInfo: { endCursor: null, hasNextPage: false }, asOf: "2026-10-05T00:00:00.000Z" });
      if (path === "/api/v2/admin/saved-views?scope=case") return response({ items: committed ? [viewA, createdView] : [viewA] });
      if (path === "/api/v2/admin/saved-views" && init?.method === "POST") { writeStarted = true; return createResponse; }
      throw new Error(`Unexpected request ${init?.method ?? "GET"} ${path}`);
    });
    await mount();
    await waitUntil(() => container.textContent?.includes("AUDIT-SAVEDVIEW-CASE-A") === true);
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("AUDIT-SAVEDVIEW-CASE-A"))!.click());
    await waitUntil(() => window.location.pathname === "/admin/cases/case-a");
    await act(async () => setValue(labelInput(), "New view from A"));
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Save new")!.click());
    await waitUntil(() => writeStarted);
    const rowB = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("AUDIT-SAVEDVIEW-CASE-B"))!;
    expect(rowB.disabled).toBe(false);
    await act(async () => rowB.click());
    await waitUntil(() => window.location.pathname === "/admin/cases/case-b");
    await waitUntil(() => container.querySelector("#case-detail-title")?.textContent === "AUDIT-SAVEDVIEW-CASE-B");
    await act(async () => {
      committed = true;
      resolveCreate(response({ view: createdView, duplicate: false }));
      await createResponse;
    });

    expect(window.location.pathname).toBe("/admin/cases/case-b");
    expect(new URLSearchParams(window.location.search).get("case")).toBe(caseB.id);
    expect(container.querySelector<HTMLButtonElement>('button[aria-current="true"]')?.textContent).toContain("AUDIT-SAVEDVIEW-CASE-B");
    expect(container.querySelector("#case-detail-title")?.textContent).toBe("AUDIT-SAVEDVIEW-CASE-B");
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });
});
