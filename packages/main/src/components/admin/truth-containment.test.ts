import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ExperimentsView } from "./ExperimentsView";
import { InsightsView } from "./InsightsView";

describe("Phase 0 metric truth containment", () => {
  it("labels unassigned flags as monitoring rather than experiments", () => {
    const html = renderToStaticMarkup(createElement(ExperimentsView));
    expect(html).toContain("Flag Monitoring");
    expect(html).toContain("no assignment or exposure records");
    expect(html).not.toContain(">Experiments<");
  });

  it("does not render legacy D1/D7 percentages or an export action", () => {
    const html = renderToStaticMarkup(createElement(InsightsView));
    expect(html).toContain("D1 / D7 retention · invalid for decisions");
    expect(html).toContain("Values and export are unavailable");
    expect(html).not.toContain("Export CSV");
  });
});
