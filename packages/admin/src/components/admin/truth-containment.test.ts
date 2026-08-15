import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ExperimentsView } from "./ExperimentsView";
import {
  InsightsView,
  ProfileHealthMetrics,
  type Health,
} from "./InsightsView";

describe("Phase 0 metric truth containment", () => {
  it("labels unassigned flags as monitoring rather than experiments", () => {
    const html = renderToStaticMarkup(createElement(ExperimentsView));
    expect(html).toContain("Managed experiment workspace");
    expect(html).toContain("Create draft");
    expect(html).toContain("Flag Monitoring");
    expect(html).toContain("no assignment or exposure records");
    expect(html).toContain("min-h-11");
    expect(html).toContain("bg-[var(--ad-ink)]");
    expect(html).not.toContain("var(--ad-accent)");
    expect(html).toContain('pattern="[a-z0-9][a-z0-9._\\-]*"');
    expect(html).not.toContain("lift=");
    expect(html).not.toContain(">Experiments<");
  });

  it("does not render legacy D1/D7 percentages or an export action", () => {
    const html = renderToStaticMarkup(createElement(InsightsView));
    expect(html).toContain("D1 / D7 retention · invalid for decisions");
    expect(html).toContain("Values and export are unavailable");
    expect(html).not.toContain("Export CSV");
  });

  it("renders an unavailable generation success rate as a dash", () => {
    const health: Health = {
      metrics: {
        total: 0,
        completed: 0,
        failed: 0,
        blocked: 0,
        successRate: null,
        blockedRate: 0,
        refundRate: 0,
        latencyP50Ms: 0,
        latencyP95Ms: 0,
      },
    };
    const html = renderToStaticMarkup(
      createElement(ProfileHealthMetrics, { health }),
    );

    expect(html).toContain(">—<");
    expect(html).not.toContain("null%");
    expect(html).not.toContain("Success</p><p class=\"mt-1 text-lg font-semibold\">100%");
  });

  it("names the deterministic preflight a configuration check and discloses its limits", () => {
    const html = renderToStaticMarkup(createElement(InsightsView));

    expect(html).toContain("Profile health + configuration check");
    expect(html).toContain("does not call a provider or generate media");
    expect(html).toContain(">Configuration check</button>");
    expect(html).not.toContain(">Dry-run</button>");
  });
});
