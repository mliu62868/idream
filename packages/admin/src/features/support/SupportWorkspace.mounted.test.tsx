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

  // SPEC: 「多久没动过」相对**这批数据的抓取时刻**（响应的 asOf），不是相对渲染那一瞬。
  // INTENT: 这条用例原来用 Date.now() - 3d 造数据、靠真实时钟对齐——既依赖运行时刻，
  //         也和组件的语义对不上：同一份未刷新的数据不该因为重渲染改变天数。
  //         夹具 asOf 是 2026-08-16T00:00:00Z，所以 3 天前就是 08-13。
  it("says how long a ticket has been sitting since its last movement", async () => {
    await mount([
      {
        ...baseTicket,
        slaState: "on_track",
        slaHoursRemaining: 20,
        slaDueAt: "2026-08-16T20:00:00.000Z",
        updatedAt: "2026-08-13T00:00:00.000Z",
      },
    ]);
    await waitUntil(() => container.textContent?.includes("SUP-CLOCK-1") === true);
    expect(container.textContent).toContain("3d ago");
  });

  // 回归：分享出去的链接必须打开就是链接里那套筛选。此前只有 pushState 写出去，
  // 刷新或别人点开都会退回默认筛选——链接看着能分享，打开是错的。
  it("opens a shared link on the filters the link encodes, not the defaults", async () => {
    window.history.replaceState(null, "", "/admin/support?status=waiting_on_user&sla=overdue&category=billing");
    await mount([]);
    const request = apiGet.mock.calls.at(-1)?.[0] ?? "";
    expect(request).toContain("status=waiting_on_user");
    expect(request).toContain("sla=overdue");
    expect(request).toContain("category=billing");
    expect(
      container.querySelector<HTMLSelectElement>('select[aria-label="Support status"]')?.value,
    ).toBe("waiting_on_user");
    expect(container.querySelector<HTMLSelectElement>('select[aria-label="Support SLA"]')?.value).toBe("overdue");
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

  // 回归：以前只有「下一页」，翻过去就回不来，也看不出自己在第几页。
  it("walks forward and back through the pages it visited", async () => {
    apiGet.mockImplementation(async () => {
      reads += 1;
      return {
        items: [{ ...baseTicket, slaState: "on_track", slaHoursRemaining: 4, slaDueAt: null, updatedAt: null }],
        pageInfo: { endCursor: "support-cursor-2", hasNextPage: true },
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
    await waitUntil(() => container.textContent?.includes("SUP-CLOCK-1") === true);

    const button = (label: string) =>
      [...container.querySelectorAll("button")].find((node) => node.textContent?.trim() === label);
    expect(button("Previous page")?.disabled).toBe(true);
    expect(container.textContent).toContain("Page 1");

    await act(async () => button("Next page")?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await waitUntil(() => apiGet.mock.calls.some(([path]) => path.includes("cursor=support-cursor-2")));
    await waitUntil(() => container.textContent?.includes("Page 2") === true);
    expect(button("Previous page")?.disabled).toBe(false);

    await act(async () => button("Previous page")?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await waitUntil(() => container.textContent?.includes("Page 1") === true);
    // 单向 operation 不接受 before；回上一页发的是自己走过的那个前向游标（第一页即无游标）。
    expect(apiGet.mock.calls.at(-1)?.[0]).not.toContain("before=");
    expect(apiGet.mock.calls.at(-1)?.[0]).not.toContain("cursor=");
  });
});
