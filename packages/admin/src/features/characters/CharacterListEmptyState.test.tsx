import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CharacterListEmptyState } from "./CharacterListEmptyState";

describe("Character Portfolio empty states", () => {
  it("uses Character-specific empty states instead of operations queue language", () => {
    const empty = renderToStaticMarkup(
      <CharacterListEmptyState onClear={() => undefined} view="all" />,
    );
    const filtered = renderToStaticMarkup(
      <CharacterListEmptyState onClear={() => undefined} view="filtered" />,
    );

    // SPEC: 筛「需要处理」而零结果是好消息，语气必须和"没找到"分开——运营每天点它就为看这句。
    const attentionClear = renderToStaticMarkup(
      <CharacterListEmptyState onClear={() => undefined} view="attention" />,
    );
    expect(attentionClear).toContain("No character needs attention right now");
    expect(attentionClear).toContain(
      "Every eligible live character has exposure or funnel observations.",
    );
    expect(attentionClear).not.toContain("image pack");
    expect(attentionClear).not.toContain("No characters match these filters");

    const imagePacksClear = renderToStaticMarkup(
      <CharacterListEmptyState
        onClear={() => undefined}
        view="live_asset_pack_incomplete"
      />,
    );
    expect(imagePacksClear).toContain("Every live image pack is complete");
    expect(imagePacksClear).toContain(
      "No live Character is missing a required image placement.",
    );

    expect(empty).toContain("No characters yet");
    expect(empty).toContain("No characters are available yet.");
    expect(filtered).toContain("No characters match these filters");
    expect(filtered).toContain("Clear filters to return to all characters.");
    expect(`${empty}${filtered}`).not.toMatch(/queue|incident|case|authority/i);
  });
});
