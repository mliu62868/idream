import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BillingWorkspace } from "./BillingWorkspace";

describe("Billing workspace permission surface", () => {
  it("keeps authority filters visible but hides ledger mutation without billing.ledger.adjust", () => {
    const html = renderToStaticMarkup(
      <BillingWorkspace canAdjust={false} canReconcile={false} canRefund={false} />,
    );

    expect(html).toContain("Billing Operations");
    expect(html).toContain("Search billing records");
    expect(html).toContain("Adjusting customer Dreamcoin balances is unavailable");
    expect(html).toContain("Reconciling checkout exceptions is unavailable");
    expect(html).toContain("Refunding subscriptions is unavailable");
    expect(html).not.toContain("is not granted");
    expect(html).not.toContain("Adjust Ledger");
    expect(html).toContain('aria-label="Loading billing records…"');
  });

  it("preserves the accessible compatibility controls when ledger adjustment is granted", () => {
    const html = renderToStaticMarkup(
      <BillingWorkspace canAdjust canReconcile={false} canRefund={false} />,
    );

    expect(html).toContain("Adjustment user ID");
    expect(html).toContain("Adjustment delta");
    expect(html).toContain(">Adjust<");
  });

  it("does not describe reconciliation as read only when its dedicated permission is granted", () => {
    const html = renderToStaticMarkup(
      <BillingWorkspace canAdjust={false} canReconcile canRefund={false} />,
    );

    expect(html).toContain("Adjusting customer Dreamcoin balances is unavailable");
    expect(html).not.toContain("Reconciling checkout exceptions is unavailable");
  });
});
