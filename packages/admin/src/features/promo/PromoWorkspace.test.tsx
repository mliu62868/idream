import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PromoWorkspace } from "./PromoWorkspace";

describe("Promo workspace permissions", () => {
  it("keeps independent authorities visible in read-only mode", () => {
    const html = renderToStaticMarkup(<PromoWorkspace canWrite={false} />);
    expect(html).toContain("Redeem codes: refreshing");
    expect(html).toContain("Referrals: refreshing");
    expect(html).toContain("growth.promo.write is not granted");
    expect(html).not.toContain("Create redeem code</h2>");
  });
});
