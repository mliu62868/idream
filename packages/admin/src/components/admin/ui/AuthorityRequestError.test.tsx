import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AuthorityRequestError } from "./AuthorityRequestError";

describe("AuthorityRequestError", () => {
  it("labels retained data as a last successful snapshot", () => {
    const html = renderToStaticMarkup(
      <AuthorityRequestError
        message="Refresh failed"
        onRetry={() => undefined}
        snapshotAt="2026-07-16T12:00:00.000Z"
      />,
    );

    expect(html).toContain("Showing the last successful snapshot from");
    expect(html).toContain('dateTime="2026-07-16T12:00:00.000Z"');
  });

  it("does not claim a snapshot exists on a first-load failure", () => {
    const html = renderToStaticMarkup(
      <AuthorityRequestError message="Load failed" onRetry={() => undefined} />,
    );

    expect(html).not.toContain("last successful snapshot");
  });
});
