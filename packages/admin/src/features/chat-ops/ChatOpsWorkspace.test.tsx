import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  ChatOpsOverviewCards,
  ChatOpsWorkspace,
} from "./ChatOpsWorkspace";

describe("Chat Ops workspace permissions", () => {
  it("renders five independent authority states and explicit no-permission status", () => {
    const html = renderToStaticMarkup(<ChatOpsWorkspace canRead={false} />);
    expect(html).toContain("Overview: refreshing");
    expect(html).toContain("Provider health: refreshing");
    expect(html).toContain("Sessions: refreshing");
    expect(html).toContain("Usage: refreshing");
    expect(html).toContain("Events: refreshing");
    expect(html).toContain("chat.ops.read is not granted");
  });

  it("renders unavailable overview metrics as dashes instead of fabricated zeroes", () => {
    const html = renderToStaticMarkup(
      <ChatOpsOverviewCards overview={null} />,
    );

    expect(html.match(/>—</g)).toHaveLength(8);
    expect(html).not.toContain(">0<");
  });
});
