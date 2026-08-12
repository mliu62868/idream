// @vitest-environment happy-dom

import { act } from "react";
import { hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { adminV2Request } = vi.hoisted(() => ({
  adminV2Request: vi.fn<(path: string) => Promise<unknown>>(),
}));

vi.mock("@/lib/admin-v2-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/admin-v2-api")>();
  return { ...actual, adminV2Request };
});

import { CaseWorkspace } from "./CaseWorkspace";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const adminCase = {
  id: "case-1",
  type: "support_request",
  target: { type: "user", id: "user-1" },
  caseKey: "support:user-1",
  status: "new",
  priority: "normal",
  severity: "medium",
  ownerId: null,
  slaDueAt: "2026-08-12T00:00:00.000Z",
  reportCount: 1,
  messageCount: 0,
  resolutionSummary: null,
  verification: null,
  relatedIncidentIds: [],
  relatedCaseIds: [],
  version: 1,
  createdAt: "2026-08-11T00:00:00.000Z",
  updatedAt: "2026-08-11T00:00:00.000Z",
};

function listResponse(view: string) {
  return {
    items: [adminCase],
    pageInfo: { endCursor: null, hasNextPage: false },
    asOf: "2026-08-11T00:00:00.000Z",
    freshness: "live",
    query: {
      view,
      cursor: null,
      limit: 30,
      sort: "updated_desc",
    },
  };
}

async function waitUntil(predicate: () => boolean) {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for Cases workspace");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

describe("CaseWorkspace browser URL interactions", () => {
  let container: HTMLDivElement;
  let root: Root | null;

  beforeEach(() => {
    adminV2Request.mockReset();
    adminV2Request.mockImplementation(async (path) => {
      if (path === "/api/v2/admin/cases/case-1") {
        return { case: adminCase, evidence: [], decisions: [], activity: [] };
      }
      const view = new URL(path, "http://admin.local").searchParams.get("view") ?? "mine";
      return listResponse(view);
    });
    window.history.replaceState(null, "", "/admin/cases?view=unassigned");
    container = document.createElement("div");
    document.body.append(container);
    root = null;
  });

  afterEach(async () => {
    await act(async () => root?.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it("hydrates the URL view, changes queues, and opens a case without losing query state", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const browserWindow = window;
    vi.stubGlobal("window", undefined);
    const serverMarkup = renderToString(
      <CaseWorkspace canAssign={false} canDecide={false} />,
    );
    vi.unstubAllGlobals();
    expect(window).toBe(browserWindow);
    container.innerHTML = serverMarkup;

    await act(async () => {
      root = hydrateRoot(
        container,
        <CaseWorkspace canAssign={false} canDecide={false} />,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await waitUntil(() => adminV2Request.mock.calls.some(([path]) => path.includes("/api/v2/admin/cases?")));
    expect(adminV2Request.mock.calls.find(([path]) => path.includes("/api/v2/admin/cases?"))?.[0]).toContain("view=unassigned");
    expect(findButton("unassigned")?.getAttribute("aria-pressed")).toBe("true");
    expect(window.location.search).toContain("view=unassigned");
    expect(consoleError).not.toHaveBeenCalled();

    await act(async () => findButton("overdue")?.click());
    await waitUntil(() => adminV2Request.mock.calls.some(([path]) => path.includes("view=overdue")));
    expect(findButton("overdue")?.getAttribute("aria-pressed")).toBe("true");
    expect(window.location.search).toContain("view=overdue");

    const caseRow = container.querySelector<HTMLButtonElement>('[aria-label="Case results"] > button');
    await act(async () => caseRow?.click());
    await waitUntil(() => adminV2Request.mock.calls.some(([path]) => path === "/api/v2/admin/cases/case-1"));
    expect(window.location.pathname).toBe("/admin/cases/case-1");
    expect(window.location.search).toContain("view=overdue");
    expect(container.querySelector("#case-detail-title")?.textContent).toBe("user-1");
  });

  function findButton(label: string) {
    return [...container.querySelectorAll("button")].find(
      (button) => button.textContent === label,
    );
  }
});
