// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { AdminI18nProvider } from "@/components/admin/i18n";
import { MetricReconciliation } from "./MetricReconciliation";

const { operation } = vi.hoisted(() => ({ operation: vi.fn() }));
vi.mock("@/lib/admin-v2-operation", () => ({ adminV2Operation: operation }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
let container: HTMLDivElement | null = null;
afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  operation.mockReset();
});
const report = {
  asOf: "2026-09-13T00:00:00Z",
  quality: { qualityState: "invalid", scannedFactCount: 0, checks: [{ key: "eligible_fact_presence", status: "failed", observed: 0, threshold: "> 0" }] },
  recentBackfills: [],
};
async function mount() {
  container = document.createElement("div"); document.body.append(container);
  await act(async () => { root = createRoot(container!); root.render(<AdminI18nProvider locale="zh"><MetricReconciliation /></AdminI18nProvider>); });
}
async function open() { await act(async () => { container!.querySelector("details")!.open = true; }); }
function button(label: string) { return [...container!.querySelectorAll("button")].find((item) => item.textContent === label)!; }

it("loads only on demand, renders authoritative failed checks and explains no backfill records", async () => {
  operation.mockResolvedValue(report);
  await mount(); expect(operation).not.toHaveBeenCalled();
  await open();
  expect(operation).toHaveBeenCalledWith("GET /api/v2/admin/metrics/reconciliation", {});
  expect(container!.textContent).toContain("合格来源事实");
  expect(container!.textContent).toContain("尚无回填执行记录");
  expect(container!.textContent).toContain("回填完成不代表指标已获认证");
  expect(container!.querySelector("tbody")?.textContent).toContain("> 0");
});

it("retains prior evidence on refresh failure, then retries and shows real-run counts and unknown coverage", async () => {
  operation.mockResolvedValueOnce({ ...report, recentBackfills: [{ runId: "backfill-1", source: "historical_events", status: "completed", dryRun: false, scannedCount: 11, appliedCount: 8, skippedCount: 2, mismatchCount: 1, coverage: null, cursor: "next-20", validFrom: null, startedAt: report.asOf, completedAt: report.asOf }] });
  await mount(); await open();
  expect(container!.textContent).toContain("11 / 8 / 2 / 1");
  expect(container!.textContent).toContain("正式执行");
  expect(container!.textContent).toContain("next-20");
  const cells = container!.querySelectorAll("tbody:last-child tr");
  expect([...cells].some((row) => row.textContent?.includes("backfill-1") && row.textContent.includes("—"))).toBe(true);
  operation.mockRejectedValueOnce(new Error("offline"));
  await act(async () => button("刷新").click());
  expect(container!.querySelector('[role="alert"]')).not.toBeNull();
  expect(container!.textContent).toContain("backfill-1");
  operation.mockResolvedValueOnce(report);
  await act(async () => button("重试").click());
  expect(container!.querySelector('[role="alert"]')).toBeNull();
  expect(container!.textContent).not.toContain("backfill-1");
});
