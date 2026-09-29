// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { adminV2Request } = vi.hoisted(() => ({ adminV2Request: vi.fn() }));

vi.mock("@/lib/admin-v2-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/admin-v2-api")>();
  return { ...actual, adminV2Request };
});
vi.mock("@/components/admin/i18n", () => {
  const interpolate = (text: string, values?: Readonly<Record<string, string | number>>) =>
    Object.entries(values ?? {}).reduce((result, [key, value]) => result.replaceAll(`{${key}}`, String(value)), text);
  return { useAdminI18n: () => ({ locale: "en" as const, t: interpolate, value: (key: string) => key }) };
});

import { ServiceHealthStrip } from "./ServiceHealthStrip";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const service = (key: "chat" | "image" | "video", state: "ok" | "degraded" | "down", attempts = 0, failures = 0) => ({
  key, state, probeOk: state !== "down", detail: state === "down" ? "connect ECONNREFUSED 127.0.0.1:8061" : null, attemptsLastHour: attempts, failuresLastHour: failures,
});

describe("ServiceHealthStrip", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    adminV2Request.mockReset();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function mount() {
    await act(async () => root.render(createElement(ServiceHealthStrip)));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }

  it("raises an alert naming the service that is down and how the others fare", async () => {
    adminV2Request.mockResolvedValue({ checkedAt: "2026-09-29T00:00:00.000Z", services: [service("chat", "down"), service("image", "degraded", 10, 3), service("video", "ok", 4, 0)] });
    await mount();
    const strip = container.querySelector('[data-testid="service-health"]')!;
    expect(strip.getAttribute("role")).toBe("alert");
    expect(strip.textContent).toContain("Service problem");
    expect(strip.textContent).toContain("Chat serviceDown");
    expect(strip.textContent).toContain("3 of 10 failed in the last hour");
    expect(strip.querySelector('a[href="/admin/ops/chat"]')?.getAttribute("title")).toContain("ECONNREFUSED");
    expect(adminV2Request.mock.calls[0]?.[0]).toBe("/api/v2/admin/ops/health");
  });

  it("stays quiet when every service is up", async () => {
    adminV2Request.mockResolvedValue({ checkedAt: "2026-09-29T00:00:00.000Z", services: [service("chat", "ok", 12), service("image", "ok"), service("video", "ok")] });
    await mount();
    const strip = container.querySelector('[data-testid="service-health"]')!;
    expect(strip.getAttribute("role")).toBe("status");
    expect(strip.textContent).toContain("All services up");
  });

  it("renders nothing rather than a false all-clear when health cannot be read", async () => {
    adminV2Request.mockRejectedValue(new Error("forbidden"));
    await mount();
    expect(container.querySelector('[data-testid="service-health"]')).toBeNull();
  });
});
