import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BillingWorkspace } from "./BillingWorkspace";

describe("Billing workspace permission surface", () => {
  it("keeps authority filters visible but hides ledger mutation without billing.ledger.adjust", () => {
    const html = renderToStaticMarkup(<BillingWorkspace canAdjust={false} />);

    expect(html).toContain("Billing &amp; Ledger");
    expect(html).toContain("Search billing authority");
    expect(html).toContain("Read only");
    expect(html).not.toContain("Adjust Ledger");
    expect(html).toContain('aria-label="Loading billing authority"');
  });

  it("preserves the accessible compatibility controls when ledger adjustment is granted", () => {
    const html = renderToStaticMarkup(<BillingWorkspace canAdjust />);

    expect(html).toContain("Adjustment user ID");
    expect(html).toContain("Adjustment delta");
    expect(html).toContain(">Adjust<");
  });
});
