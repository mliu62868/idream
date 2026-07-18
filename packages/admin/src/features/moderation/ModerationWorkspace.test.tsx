import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ModerationWorkspace } from "./ModerationWorkspace";

describe("Moderation workspace permissions", () => {
  it("renders three independent freshness states and hides decisions without write permission", () => {
    const html = renderToStaticMarkup(<ModerationWorkspace canDecide={false} />);
    expect(html).toContain("Reports: refreshing");
    expect(html).toContain("Media review: refreshing");
    expect(html).toContain("Appeals: refreshing");
    expect(html).toContain("safety.review.write is not granted");
  });
});
