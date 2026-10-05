// @vitest-environment happy-dom

import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminI18nProvider } from "@/components/admin/i18n";
import { AnalyticsWorkspace, ProviderOverviewWorkspace, RiskWorkspace } from "./OverviewWorkspaces";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const workspaces: Array<{ name: string; scope: string; endpoint: string; element: ReactElement }> = [
  { name: "Providers", scope: "provider", endpoint: "/api/v2/admin/ops/providers", element: <ProviderOverviewWorkspace canRead /> },
  { name: "Risk", scope: "risk", endpoint: "/api/v2/admin/risk/abuse", element: <RiskWorkspace canRead /> },
  { name: "Product Health legacy", scope: "analytics", endpoint: "/api/v2/admin/analytics/overview", element: <AnalyticsWorkspace canReadCanonical={false} canReadLegacy /> },
];
const normalWindow = { from: "2026-08-01T00:00:00.000Z", to: "2026-08-02T00:00:00.000Z" };

function payload(path: URL) {
  const window = { from: path.searchParams.get("from") ?? normalWindow.from, to: path.searchParams.get("to") ?? normalWindow.to };
  return {
    window, providers: [], deviceClusters: [], referralAbuse: [], adjustAnomalies: [],
    funnel: { signups: 0, payingUsers: null, qualityState: "invalid", validForDecisions: false, reason: "legacy", legacyObserved: { activatedUsers: 0, payingUsers: 0, conversionRate: 0 } },
    generation: { total: 0, completed: 0, failed: 0, blocked: 0, qualityState: "invalid", validForDecisions: false, reason: "legacy" },
    economy: { coinsGranted: 0, net: 0, byReason: [] }, topEvents: [],
  };
}

function setValue(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

describe.each(workspaces)("$name time window through its public workspace", ({ scope, endpoint, element }) => {
  let container: HTMLDivElement;
  let root: Root;
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

  beforeEach(() => {
    window.history.replaceState(null, "", `/admin/overview?keep=1`);
    fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockImplementation(async (input) => {
      const path = new URL(String(input), "http://admin.local");
      return new Response(JSON.stringify({ ok: true, data: payload(path) }), { status: 200 });
    });
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

  async function mount(locale: "zh" | "en" = "en") {
    await act(async () => root.render(<AdminI18nProvider locale={locale}>{element}</AdminI18nProvider>));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(endpoint);
  }

  function fields() {
    const inputs = container.querySelectorAll<HTMLInputElement>('input[type="datetime-local"]');
    expect(inputs).toHaveLength(2);
    return [inputs[0]!, inputs[1]!] as const;
  }

  async function submit() {
    const form = container.querySelector("form");
    if (!form) throw new Error("Window form is missing");
    await act(async () => { form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
  }

  it("keeps an inverted draft editable without requesting or changing the applied URL", async () => {
    await mount("zh");
    const [from, to] = fields();
    await act(async () => { setValue(from, "2026-10-06T02:00"); setValue(to, "2026-10-06T01:00"); });
    await submit();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(window.location.search).toBe("?keep=1");
    expect(from.value).toBe("2026-10-06T02:00");
    expect(to.value).toBe("2026-10-06T01:00");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("开始时间不能晚于结束时间");
    await act(async () => setValue(to, "2026-10-06T03:00"));
    expect(container.querySelector('[role="alert"]')).toBeNull();
    await submit();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const applied = new URL(String(fetchMock.mock.calls[1]?.[0]), "http://admin.local");
    expect(applied.searchParams.get("from")).toBe(new Date("2026-10-06T02:00").toISOString());
    expect(applied.searchParams.get("to")).toBe(new Date("2026-10-06T03:00").toISOString());
  });

  it("accepts a future empty window, an inclusive instant, Reset, and a relative preset", async () => {
    await mount();
    const [from, to] = fields();
    await act(async () => { setValue(from, "2100-10-06T00:00"); setValue(to, "2100-10-06T01:00"); });
    await submit();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(new URL(window.location.href).searchParams.get(`${scope}From`)).toBe(new Date("2100-10-06T00:00").toISOString());
    await act(async () => setValue(to, "2100-10-06T00:00"));
    await submit();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const reset = Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.trim() === "Reset");
    if (!reset) throw new Error("Reset is missing");
    await act(async () => reset.click());
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(String(fetchMock.mock.calls[3]?.[0])).toBe(endpoint);
    expect(window.location.search).toBe("?keep=1");
    expect(from.value).toBe("");
    expect(to.value).toBe("");
    const preset = Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.trim() === "Last hour");
    if (!preset) throw new Error("Last hour preset is missing");
    await act(async () => preset.click());
    const request = new URL(String(fetchMock.mock.calls[4]?.[0]), "http://admin.local");
    expect(request.searchParams.has("from")).toBe(true);
    expect(request.searchParams.has("to")).toBe(false);
  });

  it("keeps an authority-rejected history window separate from a previous normal empty result", async () => {
    await mount();
    expect(container.textContent).toContain("The authority returned no rows for this window.");
    fetchMock.mockImplementationOnce(async () => new Response(JSON.stringify({ ok: false, error: { code: "bad_request", message: "Invalid window", requestId: "inverted-window-history" } }), { status: 400 }));
    const params = new URLSearchParams({ keep: "1", [`${scope}From`]: "2026-10-06T02:00:00.000Z", [`${scope}To`]: "2026-10-06T01:00:00.000Z" });
    window.history.pushState(null, "", `?${params}`);
    await act(async () => window.dispatchEvent(new PopStateEvent("popstate")));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[role="status"]')?.textContent).toContain("stale");
    expect(container.textContent).toContain("Invalid window");
    expect(container.textContent).not.toContain("The authority returned no rows for this window.");
    const reset = Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.trim() === "Reset");
    if (!reset) throw new Error("Reset is missing");
    await act(async () => reset.click());
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(container.textContent).not.toContain("Invalid window");
    expect(container.textContent).toContain("The authority returned no rows for this window.");
  });
});
