// @vitest-environment happy-dom

import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/image", () => ({
  default: ({ alt, src }: ComponentProps<"img">) =>
    createElement("img", { alt, src: typeof src === "string" ? src : "" }),
}));

import { CharacterDetailHero } from "./CharacterDetailHero";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const baseCharacter = {
  id: "character-1",
  title: "Avery",
  age: "24",
  description: "A public character.",
  likes: "1.2k",
  chats: "173",
  likesCount: 1200,
  chatsCount: 173,
  creator: "Official",
  image: "/character.png",
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("CharacterDetailHero", () => {
  it("repeats the card's author and reach on the detail page", () => {
    act(() => {
      root.render(
        createElement(CharacterDetailHero, {
          character: { ...baseCharacter, vivid: true },
        }),
      );
    });

    const byline = container.querySelector<HTMLElement>(
      '[data-testid="character-detail-byline"]',
    );
    expect(byline?.textContent).toContain("Official");
    expect(byline?.textContent).toContain("1.2k likes");
    expect(byline?.textContent).toContain("173 chats");
    expect(byline?.textContent).toContain("vivid");
  });

  it("omits counts a character has not earned instead of showing zeros", () => {
    act(() => {
      root.render(
        createElement(CharacterDetailHero, {
          character: {
            ...baseCharacter,
            likes: "0",
            chats: "0",
            likesCount: 0,
            chatsCount: 0,
          },
        }),
      );
    });

    const byline = container.querySelector<HTMLElement>(
      '[data-testid="character-detail-byline"]',
    );
    expect(byline?.textContent).toContain("Official");
    expect(byline?.textContent).not.toContain("likes");
    expect(byline?.textContent).not.toContain("chats");
    expect(byline?.textContent).not.toContain("vivid");
  });
});
