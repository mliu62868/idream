import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StartersSection } from "./StartersSection";

// SPEC: Starters 按 content.read 可读；新建 / 编辑 / 上下线要 content.template.write，
//       AI 辅助要 content.official.write。没有权限就不画会必然 403 的控件。
describe("StartersSection write gating", () => {
  it("hides New on the list without content.template.write", () => {
    const readOnly = renderToStaticMarkup(<StartersSection canAssist={false} canWrite={false} view={{ kind: "list" }} />);
    expect(readOnly).not.toContain("New starter template");
    expect(readOnly).toContain("ask an admin owner to grant it");

    const writer = renderToStaticMarkup(<StartersSection canAssist={false} canWrite view={{ kind: "list" }} />);
    expect(writer).toContain("New starter template");
  });

  it("drops AI assist without content.official.write and disables submit without write", () => {
    const html = renderToStaticMarkup(<StartersSection canAssist={false} canWrite={false} view={{ kind: "new" }} />);
    expect(html).not.toContain("Generate with AI");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>(?:(?!<\/button>).)*Save template draft/);

    const assisted = renderToStaticMarkup(<StartersSection canAssist canWrite view={{ kind: "new" }} />);
    expect(assisted).toContain("Generate with AI");
  });
});
