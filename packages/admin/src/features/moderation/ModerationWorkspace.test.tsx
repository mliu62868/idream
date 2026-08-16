import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ModerationWorkspace } from "./ModerationWorkspace";

describe("Moderation workspace permissions", () => {
  it("renders three independent freshness states and hides decisions without write permission", () => {
    const html = renderToStaticMarkup(<ModerationWorkspace canDecide={false} />);
    expect(html).toContain("Reports: loading");
    expect(html).toContain("Media review: loading");
    expect(html).toContain("Appeals: loading");
    expect(html).toContain("safety.review.write is not granted");
  });
});
