import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  CharacterTagsPanel,
  characterTagSelectionChanged,
} from "./CharacterTagsPanel";

describe("Character tags panel", () => {
  it("detects a changed selection regardless of order", () => {
    expect(characterTagSelectionChanged([], [])).toBe(false);
    expect(characterTagSelectionChanged(["a", "b"], ["b", "a"])).toBe(false);
    expect(characterTagSelectionChanged(["a"], ["a", "b"])).toBe(true);
    expect(characterTagSelectionChanged(["a", "b"], ["a"])).toBe(true);
    // 同长度但内容不同 —— 只比长度会漏掉这一种。
    expect(characterTagSelectionChanged(["a"], ["b"])).toBe(true);
  });

  it("states the missing grant instead of silently showing dead chips", () => {
    const html = renderToStaticMarkup(
      createElement(CharacterTagsPanel, {
        characterId: "character-1",
        canWrite: false,
      }),
    );
    expect(html).toContain("content.tag.write is not granted");
  });

  it("shows a loading authority state before the vocabulary resolves", () => {
    const html = renderToStaticMarkup(
      createElement(CharacterTagsPanel, {
        characterId: "character-1",
        canWrite: true,
      }),
    );
    expect(html).toContain("Loading tags");
    // 加载中不得先摆一个「还没有标签」的伪事实。
    expect(html).not.toContain("No tags exist yet");
  });
});
