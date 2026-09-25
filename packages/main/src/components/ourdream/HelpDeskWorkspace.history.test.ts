import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  HelpDeskHistoryPanel,
  helpDeskHistoryFailure,
} from "./HelpDeskWorkspace";

describe("HelpDeskHistoryPanel", () => {
  it("does not offer retry for a stable non-customer authority boundary", () => {
    expect(helpDeskHistoryFailure(403, {
      error: { message: "Customer history is unavailable for this account" },
    })).toEqual({
      message: "Help Desk history is available to customer accounts. This signed-in account is not a customer account.",
      retryable: false,
    });
    const html = renderToStaticMarkup(createElement(HelpDeskHistoryPanel, {
      authenticated: true,
      loading: false,
      error: "Help Desk history is available to customer accounts.",
      errorRetryable: false,
      onRefresh: vi.fn(),
      history: {
        supportRequests: [],
        reports: [],
        appeals: [],
      },
    }));

    expect(html).toContain("Help Desk history is available to customer accounts.");
    expect(html).not.toContain("Retry");
  });

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
          category: "nonconsensual_real_person",
          status: "closed",
          createdAt: "2026-08-11T10:00:00.000Z",
          decision: {
            id: "decision-1",
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
    expect(html).toContain("A real person, used without consent");
    expect(html).not.toContain("nonconsensual_real_person");
    expect(html).toContain("Decision: Closed");
    expect(html).toContain("Appeal filed");
    expect(html).toContain("Appeal · Character");
    expect(html).toContain("Linked to one of your reports");
    expect(html).toContain("Outcome: Upheld");
    // IDs stay available as a secondary support reference only.
    expect(html).not.toContain("Report report-1");
    expect(html).toContain("report-1");
  });

  it("names the Comic and Collection targets a customer reported", () => {
    const report = (id: string, targetType: string) => ({
      id, targetType, targetId: `${targetType}-1`, category: "spam", status: "open",
      createdAt: "2026-09-24T10:00:00.000Z", decision: null, appealIds: [],
    });
    const html = renderToStaticMarkup(createElement(HelpDeskHistoryPanel, {
      authenticated: true,
      loading: false,
      error: "",
      onRefresh: vi.fn(),
      history: { supportRequests: [], reports: [report("r1", "comic"), report("r2", "media_collection")], appeals: [] },
    }));
    expect(html).toContain("Comic · ");
    expect(html).toContain("Collection · ");
    expect(html).not.toContain("Content · ");
  });

  it("offers an appeal prefilled with the decision it came from", () => {
    const onAppeal = vi.fn();
    const report = {
      id: "report-2",
      targetType: "character",
      targetId: "character-2",
      category: "spam",
      status: "closed",
      createdAt: "2026-08-11T10:00:00.000Z",
      decision: { id: "decision-2", outcome: "actioned", decidedAt: "2026-08-11T11:00:00.000Z" },
      appealIds: [],
    };
    const element = HelpDeskHistoryPanel({
      authenticated: true,
      loading: false,
      error: "",
      onRefresh: vi.fn(),
      onAppeal,
      history: { supportRequests: [], reports: [report], appeals: [] },
    });
    const html = renderToStaticMarkup(element);
    expect(html).toContain("Appeal this decision");
    const button = findElement(element, (node) => node.type === "button" && String(node.props.children).includes("Appeal this decision"));
    (button!.props.onClick as () => void)();
    expect(onAppeal).toHaveBeenCalledWith({ targetType: "character", targetId: "character-2", decisionId: "decision-2" });
  });
});

type Node = { type: unknown; props: Record<string, unknown> & { children?: unknown } };
function findElement(node: unknown, match: (node: Node) => boolean): Node | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElement(child, match);
      if (found) return found;
    }
    return undefined;
  }
  if (!node || typeof node !== "object" || !("props" in node)) return undefined;
  const element = node as Node;
  if (match(element)) return element;
  return findElement(element.props.children, match);
}
