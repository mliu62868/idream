// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { CharacterPerformanceReconciliation } from "./CharacterPerformanceReconciliation";
const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("@/lib/admin-v2-api", async (original) => ({ ...await original<typeof import("@/lib/admin-v2-api")>(), adminV2Request: request }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const report = {
  scannedFunnelRows: 0, impossibleFunnelRows: 0, missingReleaseRows: 0,
  nonExactFunnelRows: 0, relevantCostAuthorities: 0, projectedCostAuthorities: 0,
  missingVariableCostFacts: 0, unauditedEconomicsFacts: 0, partialEconomicsFacts: 0,
  cashRevenueAuthorityState: "unavailable", refundAuthorityState: "unavailable",
  creditAuthorityState: "unavailable", qualityState: "directional",
};

describe("character fact reconciliation", () => {
  let container: HTMLDivElement; let root: Root;
  beforeEach(() => { request.mockReset(); container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
  const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 15)); });
  it("loads global evidence on demand and never describes empty facts as financial sign-off", async () => {
    request.mockResolvedValue(report);
    await act(async () => root.render(<CharacterPerformanceReconciliation />));
    expect(request).not.toHaveBeenCalled();
    await act(async () => container.querySelector("button")!.click()); await settle();
    expect(request.mock.calls[0][0]).toBe("/api/v2/admin/characters/performance/reconciliation");
    expect(container.textContent).toContain("No funnel facts are available to verify.");
    expect(container.textContent).toContain("not a financial sign-off");
    expect(container.textContent).toContain("Global facts across all characters");
  });
  it("surfaces inconsistent facts as an alert and preserves evidence when refresh fails", async () => {
    request.mockResolvedValueOnce({ ...report, qualityState: "invalid", missingVariableCostFacts: 8 })
      .mockRejectedValueOnce(new Error("reconciliation offline"));
    await act(async () => root.render(<CharacterPerformanceReconciliation />));
    await act(async () => container.querySelector("button")!.click()); await settle();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("do not use these numbers");
    expect([...container.querySelectorAll("dd")].map((node) => node.textContent)).toContain("8");
    await act(async () => [...container.querySelectorAll("button")].find((node) => node.textContent === "Refresh")!.click());
    expect(container.textContent).toContain("reconciliation offline");
    expect([...container.querySelectorAll("dd")].map((node) => node.textContent)).toContain("8");
  });
});
