import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AnalyticsWorkspace, ProviderOverviewWorkspace, RiskWorkspace, withReportableLatency } from "./OverviewWorkspaces";

describe("overview workspace permissions", () => {
  it("renders explicit no-permission states without starting hidden authorities", () => {
    const html = renderToStaticMarkup(
      <>
        <AnalyticsWorkspace canReadCanonical={false} canReadLegacy={false} />
        <RiskWorkspace canRead={false} />
        <ProviderOverviewWorkspace canRead={false} />
      </>,
    );
    expect(html).toContain("metrics.read is not granted");
    expect(html).toContain("billing.read is not granted");
    expect(html).toContain("ops.queue.read is not granted");
  });
});

describe("provider latency percentiles", () => {
  // SPEC: 百分位只在样本撑得起时才是事实。
  // INTENT: 实测 `unknown` 供应商 25 次请求失败 14 次、延迟样本只有 1 个，表里却印着
  //         p50 1ms / p95 1ms。运营会据此判定它很快 —— 而它一半以上的请求根本没跑完。
  it("hides percentiles computed from too few samples and keeps the sample count visible", () => {
    const thin = withReportableLatency({ provider: "unknown", latencyP50Ms: 1, latencyP95Ms: 1, latencySamples: 1 });
    expect(thin).toMatchObject({ latencyP50Ms: null, latencyP95Ms: null, latencySamples: 1 });
  });

  it("leaves a well-sampled provider untouched", () => {
    const row = { provider: "comfyui", latencyP50Ms: 83070, latencyP95Ms: 785821, latencySamples: 54 };
    expect(withReportableLatency(row)).toBe(row);
  });

  it("passes through rows whose sample count the authority did not report", () => {
    const row = { provider: "mock-pipeline", latencyP50Ms: null, latencyP95Ms: null };
    expect(withReportableLatency(row)).toBe(row);
  });
});
