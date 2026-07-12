import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SupportWorkspace } from "./SupportWorkspace";

describe("Support workspace permissions", () => {
  it("renders read-only and plaintext-unavailable states", () => {
    const html = renderToStaticMarkup(
      <SupportWorkspace canViewPlaintext={false} canWrite={false} />,
    );
    expect(html).toContain("support.request.write is not granted");
    expect(html).toContain("support.plaintext.view is not granted");
    expect(html).not.toContain("Plaintext access</h2>");
  });
});
