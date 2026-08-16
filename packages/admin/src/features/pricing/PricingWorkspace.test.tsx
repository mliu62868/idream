import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PricingWorkspace } from "./PricingWorkspace";

describe("Pricing workspace permission surface", () => {
  it("keeps authority search visible but hides every write control without config.pricing.write", () => {
    const html = renderToStaticMarkup(<PricingWorkspace canWrite={false} />);
    expect(html).toContain("Pricing");
    expect(html).toContain("Search prices");
    expect(html).not.toContain("Create Pricing Rule Draft");
    expect(html).toContain("Read only");
  });
});
