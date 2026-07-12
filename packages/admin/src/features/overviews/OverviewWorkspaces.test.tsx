import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AnalyticsWorkspace, ProviderOverviewWorkspace, RiskWorkspace } from "./OverviewWorkspaces";

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
