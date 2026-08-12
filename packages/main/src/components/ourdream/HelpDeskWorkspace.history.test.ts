import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { HelpDeskHistoryPanel } from "./HelpDeskWorkspace";

describe("HelpDeskHistoryPanel", () => {
  it("renders durable support, report, linkage, and appeal outcomes", () => {
    const html = renderToStaticMarkup(createElement(HelpDeskHistoryPanel, {
      authenticated: true,
      loading: false,
      error: "",
      onRefresh: vi.fn(),
      history: {
        supportRequests: [{
          id: "support-1",
          ticketId: "SUP-123",
          category: "bug",
          subject: "Generator issue",
          status: "resolved",
          createdAt: "2026-08-11T10:00:00.000Z",
          updatedAt: "2026-08-11T11:00:00.000Z",
          resolution: {
            outcome: "resolved",
            resolvedAt: "2026-08-11T11:00:00.000Z",
          },
        }],
        reports: [{
          id: "report-1",
          targetType: "character",
          targetId: "character-1",
          category: "other",
          status: "closed",
          createdAt: "2026-08-11T10:00:00.000Z",
          decision: {
            outcome: "closed",
            decidedAt: "2026-08-11T11:00:00.000Z",
          },
          appealIds: ["appeal-1"],
        }],
        appeals: [{
          id: "appeal-1",
          targetType: "character",
          targetId: "character-1",
          status: "upheld",
          createdAt: "2026-08-11T12:00:00.000Z",
          relatedReportId: "report-1",
          outcome: {
            result: "upheld",
            resolvedAt: "2026-08-11T13:00:00.000Z",
          },
        }],
      },
    }));

    expect(html).toContain("SUP-123");
    expect(html).toContain("Generator issue");
    expect(html).toContain("Resolved");
    expect(html).toContain("Report report-1");
    expect(html).toContain("Decision: Closed");
    expect(html).toContain("Appeal appeal-1");
    expect(html).toContain("Related report: report-1");
    expect(html).toContain("Outcome: Upheld");
  });
});
