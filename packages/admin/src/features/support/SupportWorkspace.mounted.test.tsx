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

describe("SupportWorkspace mounted URL state", () => {
  let container: HTMLDivElement;
  let root: Root | null;

  beforeEach(() => {
    apiGet.mockReset();
    // Saved Views 走 `adminV2Request`（真 fetch），不再经 `apiGet` —— 桩住它，
    // 否则 happy-dom 会真的发一次请求，然后在 teardown 时抛 AbortError。
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, data: { items: [] } }), {
        headers: { "content-type": "application/json" },
      }),
    ));
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
