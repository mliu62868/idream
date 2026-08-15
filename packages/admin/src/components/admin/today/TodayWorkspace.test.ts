import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { TodayRecoveryNotice } from "./TodayWorkspace";

const t = (key: string) => key;

describe("Today workspace recovery states", () => {
  it("turns an initial transport failure into a retryable operator message", () => {
    const html = renderToStaticMarkup(createElement(TodayRecoveryNotice, {
      error: "Failed to fetch",
      hasData: false,
      loading: false,
      onRetry: vi.fn(),
      t,
    }));

    expect(html).toContain("Today&#x27;s work could not be loaded.");
    expect(html).toContain("Reconnect and retry to restore the authoritative queue.");
    expect(html).toContain(">Retry</button>");
    expect(html).toContain('role="alert"');
    expect(html).not.toContain("Failed to fetch");
  });

  it("labels a stale snapshot while refresh is pending or failed", () => {
    const loading = renderToStaticMarkup(createElement(TodayRecoveryNotice, {
      error: null,
      hasData: true,
      loading: true,
      onRetry: vi.fn(),
      t,
    }));
    const failed = renderToStaticMarkup(createElement(TodayRecoveryNotice, {
      error: "Failed to fetch",
      hasData: true,
      loading: false,
      onRetry: vi.fn(),
      t,
    }));

    expect(loading).toContain("Refreshing Today. Showing the last loaded snapshot.");
    expect(loading).toContain('role="status"');
    expect(failed).toContain("Today refresh failed. Showing the last loaded snapshot.");
    expect(failed).toContain(">Retry</button>");
  });
});
