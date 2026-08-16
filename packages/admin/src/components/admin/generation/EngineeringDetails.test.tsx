import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EngineeringDetails } from "./EngineeringDetails";

describe("EngineeringDetails", () => {
  // SPEC: 摘要行此前无条件在右侧再打印一次字面量 "Engineering details"，和调用方自己的
  // summary 叠加成「Connection details … Engineering details」。可展开的提示归 chevron。
  it("shows the caller's summary once and never appends a second label", () => {
    const html = renderToStaticMarkup(
      <EngineeringDetails summary="Connection details">
        <div>endpoint</div>
      </EngineeringDetails>,
    );

    expect(html).toContain("Connection details");
    expect(html.match(/Engineering details/g) ?? []).toHaveLength(1);
    expect(html).toContain('aria-label="Engineering details"');
  });

  it("does not print the label twice when the caller's summary is already the label", () => {
    const html = renderToStaticMarkup(
      <EngineeringDetails summary="Engineering details">
        <div>starter.id = abc</div>
      </EngineeringDetails>,
    );

    expect(html.match(/>Engineering details</g) ?? []).toHaveLength(1);
  });

  it("stays collapsed by default so operators never see identifiers first", () => {
    const html = renderToStaticMarkup(
      <EngineeringDetails summary="Recipe details">
        <div>recipe-1</div>
      </EngineeringDetails>,
    );

    expect(html).not.toContain("<details open");
  });
});
