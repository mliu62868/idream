import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CharacterListEmptyState } from "./CharacterPortfolio";

describe("Character Portfolio list", () => {
  it("uses Character-specific empty states instead of operations queue language", () => {
    const empty = renderToStaticMarkup(
      <CharacterListEmptyState filtered={false} onClear={() => undefined} />,
    );
    const filtered = renderToStaticMarkup(
      <CharacterListEmptyState filtered onClear={() => undefined} />,
    );

    // SPEC: 筛「需要处理」而零结果是好消息，语气必须和"没找到"分开——运营每天点它就为看这句。
    const attentionClear = renderToStaticMarkup(
      <CharacterListEmptyState attentionOnly filtered onClear={() => undefined} />,
    );
    expect(attentionClear).toContain("No character needs attention right now");
    expect(attentionClear).not.toContain("No characters match these filters");

    expect(empty).toContain("No characters yet");
    expect(empty).toContain("No characters are available yet.");
    expect(filtered).toContain("No characters match these filters");
    expect(filtered).toContain("Clear filters to return to all characters.");
    expect(`${empty}${filtered}`).not.toMatch(/queue|incident|case|authority/i);
  });
});
