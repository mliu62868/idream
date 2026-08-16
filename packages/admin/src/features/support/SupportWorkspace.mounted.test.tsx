// @vitest-environment happy-dom

import { act } from "react";
import { hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { apiGet } = vi.hoisted(() => ({
  apiGet: vi.fn<(path: string) => Promise<unknown>>(),
}));

vi.mock("@/components/admin/api", () => ({
  apiDelete: vi.fn(),
  apiGet,
  apiWrite: vi.fn(),
}));

import { createRoot } from "react-dom/client";
import { ToastProvider } from "@/components/admin/ui/Toast";
import { SupportWorkspace } from "./SupportWorkspace";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function waitUntil(predicate: () => boolean) {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for Support workspace");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

// Saved Views 走 `adminV2Request`（真 fetch），不再经 `apiGet`——桩住它，
// 否则 happy-dom 会真的发一次请求，然后在 teardown 时抛 AbortError。
function stubSavedViewsFetch() {
  vi.stubGlobal("fetch", vi.fn(async () =>
    new Response(JSON.stringify({ ok: true, data: { items: [] } }), {
      headers: { "content-type": "application/json" },
    }),
  ));
}

beforeEach(stubSavedViewsFetch);

describe("SupportWorkspace mounted URL state", () => {
  let container: HTMLDivElement;
  let root: Root | null;

  beforeEach(() => {
    apiGet.mockReset();
    apiGet.mockImplementation(async () =>
      ({
            items: [
              {
                ticketId: "SUP-R5E27H6PS9",
                userEmail: "customer@example.com",
                category: "account",
                subject: "Cannot update my profile",
                description: "Profile changes are not saved.",
                status: "received",
                priority: "normal",
                slaState: "on_track",
                createdAt: "2026-08-11T00:00:00.000Z",
              },
            ],
            pageInfo: { endCursor: null, hasNextPage: false },
            asOf: "2026-08-11T00:00:00.000Z",
            freshness: "fresh",
      }),
    );
    window.history.replaceState(null, "", "/admin/support?search=SUP-R5E27H6PS9");
    container = document.createElement("div");
    document.body.append(container);
    root = null;
  });

  afterEach(async () => {
    await act(async () => root?.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it("hydrates deterministic markup before restoring the URL query", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const browserWindow = window;
    vi.stubGlobal("window", undefined);
    const serverMarkup = renderToString(
      <SupportWorkspace canViewPlaintext={false} canWrite={true} />,
    );
    vi.unstubAllGlobals();
    // 撤 window 桩的同时也把 fetch 桩撤掉了——Saved Views 排在 setTimeout(0) 上的那次请求
    // 就会打到真网络（teardown 时冒出一条 401）。补回来，空窗才不存在。
    stubSavedViewsFetch();
    expect(window).toBe(browserWindow);
    container.innerHTML = serverMarkup;

    await act(async () => {
      root = hydrateRoot(
        container,
        <SupportWorkspace canViewPlaintext={false} canWrite={true} />,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await waitUntil(() =>
      apiGet.mock.calls.some(([path]) => path.includes("/api/v2/admin/support/requests?")),
    );
    expect(
      apiGet.mock.calls.find(([path]) => path.includes("/api/v2/admin/support/requests?"))?.[0],
    ).toContain("search=SUP-R5E27H6PS9");
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Support search"]')?.value).toBe(
      "SUP-R5E27H6PS9",
    );
    expect(
      container.querySelector('[aria-label="Support Requests scrollable table"] table')?.className,
    ).toContain("min-w-[2000px]");
    expect(consoleError).not.toHaveBeenCalled();
  });
});

const baseTicket = {
  ticketId: "SUP-CLOCK-1",
  userEmail: "customer@example.com",
  category: "billing",
  subject: "Charged twice",
  description: "The same order shows up twice on my statement.",
  status: "open",
  priority: 2,
  assignedToEmail: "agent@example.com",
  slaEscalatedAt: null,
  slaEscalationReason: null,
  resolutionNotes: null,
  createdAt: "2026-08-10T00:00:00.000Z",
};

describe("SupportWorkspace queue triage signals", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let reads: number;

  beforeEach(() => {
    window.history.replaceState(null, "", "/admin/support");
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    reads = 0;
    apiGet.mockReset();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    // 不 unstubAllGlobals：Saved Views 的 setTimeout(0) 可能还没落地，
    // 撤掉 fetch 桩会让它打到真网络（teardown 时冒出一条 401）。
    vi.restoreAllMocks();
  });

  async function mount(items: unknown[]) {
    apiGet.mockImplementation(async () => {
      reads += 1;
      return {
        items,
        pageInfo: { endCursor: null, hasNextPage: false },
        asOf: "2026-08-16T00:00:00.000Z",
        freshness: "fresh",
      };
    });
    await act(async () => {
      root.render(
        <ToastProvider>
          <SupportWorkspace canViewPlaintext={false} canWrite />
        </ToastProvider>,
      );
    });
    await waitUntil(() => reads >= 1);
  }

  // 剩余小时数是服务端按 priority→小时表算好一起发过来的，以前工作台只画了绝对截止时间戳，
  // 客服得自己拿当前时间做减法才知道急不急。
  it("turns the SLA clock into how long is actually left", async () => {
    await mount([
      {
        ...baseTicket,
        slaState: "overdue",
        slaHoursRemaining: -5,
        slaDueAt: "2026-08-15T19:00:00.000Z",
        updatedAt: "2026-08-15T19:00:00.000Z",
      },
    ]);
    await waitUntil(() => container.textContent?.includes("SUP-CLOCK-1") === true);
    expect(container.textContent).toContain("Overdue by 5h");
  });

  it("counts down a ticket that is still inside its SLA", async () => {
    await mount([
      {
        ...baseTicket,
        slaState: "due_soon",
        slaHoursRemaining: 3,
        slaDueAt: "2026-08-16T03:00:00.000Z",
        updatedAt: "2026-08-16T00:00:00.000Z",
      },
    ]);
    await waitUntil(() => container.textContent?.includes("SUP-CLOCK-1") === true);
    expect(container.textContent).toContain("3h left");
  });

  // paused / closed 本来就没有截止时间，不能编一个倒计时出来。
  it("shows no countdown when the authority reports no deadline", async () => {
    await mount([
      {
        ...baseTicket,
        status: "waiting_on_user",
        slaState: "paused",
        slaHoursRemaining: null,
        slaDueAt: null,
        updatedAt: "2026-08-16T00:00:00.000Z",
      },
    ]);
    await waitUntil(() => container.textContent?.includes("SUP-CLOCK-1") === true);
    expect(container.textContent).not.toContain("h left");
    expect(container.textContent).not.toContain("Overdue by");
    expect(container.textContent).toContain("Not escalated");
  });

  it("says how long a ticket has been sitting since its last movement", async () => {
    await mount([
      {
        ...baseTicket,
        slaState: "on_track",
        slaHoursRemaining: 20,
        slaDueAt: "2026-08-16T20:00:00.000Z",
        updatedAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
      },
    ]);
    await waitUntil(() => container.textContent?.includes("SUP-CLOCK-1") === true);
    expect(container.textContent).toContain("3d ago");
  });

  it("offers a way out when the filters matched nothing", async () => {
    window.history.replaceState(null, "", "/admin/support?status=closed");
    await mount([]);
    await waitUntil(() => reads >= 1);
    await waitUntil(() =>
      [...container.querySelectorAll("button")].some(
        (button) => button.textContent?.trim() === "Clear filters",
      ),
    );
    const clear = [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Clear filters",
    );
    await act(async () => {
      clear?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await waitUntil(() => reads >= 2);
    expect(apiGet.mock.calls.at(-1)?.[0].includes("status=closed")).toBe(false);
  });
});
