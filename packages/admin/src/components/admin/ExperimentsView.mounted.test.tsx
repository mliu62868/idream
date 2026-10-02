// @vitest-environment happy-dom

// SPEC: 停一个线上实验此前是"点一下就停"，审计里留下的是机器写死的英文
//       `stop from Admin experiment workspace`。本用例锁住：点按钮不写、必须确认、
//       且进审计的 reason 是运营手打的那句。
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExperimentsView } from "./ExperimentsView";
import { ADMIN_WORKSPACE_REFRESH_EVENT } from "@/features/workspace-refresh";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const runningExperiment = {
  id: "experiment-1",
  key: "community.character-ranking.v1",
  version: 2,
  hypothesis: "Relationship-first ranking increases qualified conversations",
  eligibility: {},
  variants: [
    { key: "control", allocationBps: 5_000 },
    { key: "relationship_first", allocationBps: 5_000 },
  ],
  metrics: {
    primary: "relationship.qce_activation.v1",
    controlVariant: "control",
    minimumMaturePerArm: 100,
    guardrails: [],
  },
  status: "running",
  stateVersion: 7,
};

describe("ExperimentsView lifecycle commands", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    window.history.replaceState(null, "", "/admin/growth/experiments");
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("requires a confirmation and carries the operator's own reason into the audit payload", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const path = String(input);
      if (path.includes("/commands/stop")) {
        return Response.json({ ok: true, data: { experiment: runningExperiment } });
      }
      if (path.includes("/flag-monitoring")) {
        return Response.json({ ok: true, data: { items: [] } });
      }
      return Response.json({ ok: true, data: { items: [runningExperiment] } });
    });
    vi.stubGlobal("fetch", fetchMock);

    await act(async () => {
      root.render(<ExperimentsView />);
    });
    await waitFor(() => container.textContent?.includes("community.character-ranking.v1") ?? false);

    const stop = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Stop",
    );
    expect(stop).toBeDefined();

    await act(async () => {
      stop?.click();
    });
    expect(stopCalls(fetchMock)).toHaveLength(0);

    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog).not.toBeNull();
    // 后果必须在敲确认串之前就读得到，且说清楚不可逆（management.ts:158 —— stopped 回不到 running）。
    expect(dialog?.textContent).toContain("cannot be restarted");
    expect(dialog?.textContent).toContain("needs a new version");

    const inputs = Array.from(dialog?.querySelectorAll("input") ?? []);
    expect(inputs).toHaveLength(2);
    await changeInput(inputs[0], "guardrail regression on support contacts");
    await changeInput(inputs[1], "community.character-ranking.v1");

    await act(async () => {
      dialogButton(dialog, "Stop")?.click();
    });
    await waitFor(() => stopCalls(fetchMock).length === 1);

    const body = JSON.parse(String(stopCalls(fetchMock)[0][1]?.body));
    expect(body).toMatchObject({
      expectedStateVersion: 7,
      reason: "guardrail regression on support contacts",
    });
    expect(body.reason).not.toContain("Admin experiment workspace");
  });

  it("reaches older experiments through pagination and resets the cursor when filters change", async () => {
    const older = { ...runningExperiment, id: "older-running", key: "community.character-ranking.v1", version: 1 };
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname.endsWith("/flag-monitoring")) return Response.json({ ok: true, data: { items: [] } });
      const secondPage = url.searchParams.get("cursor") === "experiment-1";
      return Response.json({ ok: true, data: {
        items: [secondPage ? older : runningExperiment],
        pageInfo: { hasNextPage: !secondPage, endCursor: secondPage ? null : "experiment-1" },
        asOf: "2026-10-01T12:00:00.000Z",
      } });
    });
    vi.stubGlobal("fetch", fetchMock);
    await act(async () => root.render(<ExperimentsView />));
    await waitFor(() => container.textContent?.includes("community.character-ranking.v1") ?? false);

    const next = Array.from(container.querySelectorAll("button")).find(button => button.textContent?.trim() === "Next page");
    expect(next).toBeDefined();
    await act(async () => next?.click());
    await waitFor(() => experimentListCalls(fetchMock).some(path => path.includes("cursor=experiment-1")));
    await waitFor(() => container.textContent?.includes("· v1") ?? false);
    expect(container.querySelector('[data-testid="admin-pagination"]')?.textContent).toContain("Page 2");
    expect(new URLSearchParams(window.location.search).get("experimentCursor")).toBe("experiment-1");

    const search = container.querySelector<HTMLInputElement>('input[aria-label="experiment key or hypothesis"]');
    expect(search).not.toBeNull();
    await changeInput(search!, "community");
    const filter = search?.closest("form");
    await act(async () => filter?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    await waitFor(() => experimentListCalls(fetchMock).some(path => path.includes("search=community") && !path.includes("cursor=")));
    expect(new URLSearchParams(window.location.search).has("experimentCursor")).toBe(false);
    expect(container.querySelector('[data-testid="admin-pagination"]')?.textContent).toContain("Page 1");
  });

  it("explains engineering integration before starting a custom definition instead of promising product traffic", async () => {
    const custom = { ...runningExperiment, key: "custom.retention.v1", status: "draft" };
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => Response.json({ ok: true, data:
      String(input).includes("/flag-monitoring")
        ? { items: [] }
        : { items: [custom], pageInfo: { hasNextPage: false, endCursor: null } },
    })));
    await act(async () => root.render(<ExperimentsView />));
    await waitFor(() => container.textContent?.includes(custom.key) ?? false);
    expect(container.textContent).toContain("Engineering integration required");
    expect(container.textContent).toContain("Primary metric: QCE activation within 7 days");
    const start = Array.from(container.querySelectorAll("button")).find(button => button.textContent?.trim() === "Start");
    await act(async () => start?.click());
    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog?.textContent).toContain("No product surface is connected to this key");
    expect(dialog?.textContent).not.toContain("Real users start being assigned");
  });

  it("preserves the visited page through workspace refresh, reload, Back, and Forward", async () => {
    const fetchMock = mockPagedExperiments();
    await act(async () => root.render(<ExperimentsView />));
    await waitFor(() => container.textContent?.includes("· v2") ?? false);
    const first = { url: window.location.href, state: window.history.state };
    await act(async () => pageButton("Next page").click());
    await waitFor(() => container.textContent?.includes("· v1") ?? false);
    const second = { url: window.location.href, state: window.history.state };

    await act(async () => window.dispatchEvent(new Event(ADMIN_WORKSPACE_REFRESH_EVENT)));
    await waitFor(() => !pageButton("Previous page").disabled);
    expect(paginationText()).toContain("Page 2");

    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () => root.render(<ExperimentsView />));
    await waitFor(() => container.textContent?.includes("· v1") ?? false);
    expect(paginationText()).toContain("Page 2");
    expect(pageButton("Previous page").disabled).toBe(false);
    expect(new URLSearchParams(window.location.search).get("experimentPage")).toBe("2");

    await act(async () => {
      window.history.replaceState(first.state, "", first.url);
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await waitFor(() => container.textContent?.includes("· v2") ?? false);
    expect(paginationText()).toContain("Page 1");
    await act(async () => {
      window.history.replaceState(second.state, "", second.url);
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await waitFor(() => container.textContent?.includes("· v1") ?? false);
    expect(paginationText()).toContain("Page 2");
    expect(pageButton("Previous page").disabled).toBe(false);
    await act(async () => pageButton("Previous page").click());
    await waitFor(() => container.textContent?.includes("· v2") ?? false);
    expect(paginationText()).toContain("Page 1");
    expect(window.location.search).toBe("");
    expect(experimentListCalls(fetchMock).some(path => path.includes("experimentPage"))).toBe(false);
  });

  it("returns to the first page from a shared cursor link without inventing previous cursor evidence", async () => {
    window.history.replaceState(null, "", "/admin/growth/experiments?experimentCursor=experiment-1&experimentPage=2");
    mockPagedExperiments();
    await act(async () => root.render(<ExperimentsView />));
    await waitFor(() => container.textContent?.includes("· v1") ?? false);
    expect(paginationText()).toContain("Page 2");
    expect(pageButton("Back to first page").disabled).toBe(false);
    await act(async () => pageButton("Back to first page").click());
    await waitFor(() => container.textContent?.includes("· v2") ?? false);
    expect(paginationText()).toContain("Page 1");
    expect(window.location.search).toBe("");
  });

  it("does not reuse old rows or cursors after a new filter fails, then retries that filter", async () => {
    let filteredReads = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname.endsWith("/flag-monitoring")) return Response.json({ ok: true, data: { items: [] } });
      if (url.searchParams.get("search") === "new-query") {
        filteredReads += 1;
        if (filteredReads === 1) return Response.json({ ok: false, error: { code: "internal_error", message: "experiment list unavailable" } }, { status: 503 });
        return Response.json({ ok: true, data: { items: [{ ...runningExperiment, key: "new-query.experiment.v1" }], pageInfo: { hasNextPage: false, endCursor: null } } });
      }
      return Response.json({ ok: true, data: { items: [runningExperiment], pageInfo: { hasNextPage: true, endCursor: "old-query-cursor" } } });
    });
    vi.stubGlobal("fetch", fetchMock);
    await act(async () => root.render(<ExperimentsView />));
    await waitFor(() => !pageButton("Next page").disabled);
    const search = container.querySelector<HTMLInputElement>('input[aria-label="experiment key or hypothesis"]')!;
    await changeInput(search, "new-query");
    await act(async () => search.closest("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    await waitFor(() => container.querySelector('[role="alert"]') !== null);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Retry to load the latest data.");
    expect(container.textContent).not.toContain("community.character-ranking.v1 · v2");
    expect(container.textContent).not.toContain("No managed experiments yet.");
    expect(pageButton("Next page").disabled).toBe(true);
    expect(pageButton("Previous page").disabled).toBe(true);
    expect(new URLSearchParams(window.location.search).get("experimentSearch")).toBe("new-query");

    const retry = [...container.querySelector('[role="alert"]')!.querySelectorAll("button")].find(button => button.textContent?.trim() === "Retry")!;
    expect(retry).toBeDefined();
    await act(async () => retry.click());
    await waitFor(() => container.textContent?.includes("new-query.experiment.v1 · v2") ?? false);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(filteredReads).toBe(2);
    expect(experimentListCalls(fetchMock).some(path => path.includes("old-query-cursor"))).toBe(false);
  });

  it("reuses the same create payload and idempotency key after a lost response, then starts a fresh draft after success", async () => {
    let attempts = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input) === "/api/v2/admin/experiments" && init?.method === "POST") {
        attempts += 1;
        if (attempts === 1) throw new TypeError("The response was lost after creation");
        return Response.json({ ok: true, data: { experiment: runningExperiment } });
      }
      return Response.json({ ok: true, data: { items: [], pageInfo: { hasNextPage: false, endCursor: null } } });
    });
    vi.stubGlobal("fetch", fetchMock);
    await act(async () => root.render(<ExperimentsView />));
    const keyInput = container.querySelector<HTMLInputElement>('input[placeholder="community.character-ranking.v1"]')!;
    const hypothesisInput = container.querySelector<HTMLInputElement>('input[minlength="10"]')!;
    const create = Array.from(container.querySelectorAll("button")).find(button => button.textContent?.trim() === "Create draft")!;
    const form = keyInput.closest("form")!;
    const submit = async () => {
      await act(async () => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
      await waitFor(() => !create.disabled);
    };
    await changeInput(keyInput, runningExperiment.key);
    await changeInput(hypothesisInput, runningExperiment.hypothesis);

    await submit();
    expect(container.textContent).toContain("The response was lost after creation");
    await submit();
    const writes = fetchMock.mock.calls.filter(([, init]) => init?.method === "POST");
    expect(writes).toHaveLength(2);
    expect(writes[1][1]?.body).toBe(writes[0][1]?.body);
    expect(new Headers(writes[1][1]?.headers).get("idempotency-key"))
      .toBe(new Headers(writes[0][1]?.headers).get("idempotency-key"));
    expect(keyInput.value).toBe("");
    expect(hypothesisInput.value).toBe("");

    await changeInput(keyInput, runningExperiment.key);
    await changeInput(hypothesisInput, runningExperiment.hypothesis);
    await submit();
    const nextDraft = fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")[2][1];
    expect(JSON.parse(String(nextDraft?.body)).salt).not.toBe(JSON.parse(String(writes[0][1]?.body)).salt);
    expect(new Headers(nextDraft?.headers).get("idempotency-key"))
      .not.toBe(new Headers(writes[0][1]?.headers).get("idempotency-key"));
  });

  function mockPagedExperiments() {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname.endsWith("/flag-monitoring")) return Response.json({ ok: true, data: { items: [] } });
      const second = Boolean(url.searchParams.get("cursor"));
      return Response.json({ ok: true, data: { items: [{ ...runningExperiment, version: second ? 1 : 2 }], pageInfo: { hasNextPage: !second, endCursor: second ? null : "experiment-1" } } });
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  function paginationText() {
    return container.querySelector('[data-testid="admin-pagination"]')?.textContent;
  }

  function pageButton(label: string) {
    const button = Array.from(container.querySelectorAll("button")).find(button => button.textContent?.trim() === label);
    if (!button) throw new Error(`Missing button ${label}`);
    return button;
  }
});

function experimentListCalls(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.map(([input]) => String(input)).filter(path => path.split("?")[0] === "/api/v2/admin/experiments");
}

function stopCalls(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.filter(([input]) => String(input).includes("/commands/stop")) as [
    string,
    RequestInit | undefined,
  ][];
}

function dialogButton(dialog: HTMLElement | null, label: string) {
  return Array.from(dialog?.querySelectorAll("button") ?? []).find(
    (button) => button.textContent?.trim() === label,
  );
}

async function changeInput(input: HTMLInputElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function waitFor(predicate: () => boolean) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (predicate()) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  throw new Error("Condition did not become true");
}
