// @vitest-environment happy-dom

import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/image", () => ({
  default: ({ alt, src, className, "data-hero-fit": fit }: ComponentProps<"img"> & { "data-hero-fit"?: string }) =>
    createElement("img", { alt, className, "data-hero-fit": fit, src: typeof src === "string" ? src : "" }),
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

  it("links a user-made character's author to their creator page", () => {
    act(() => {
      root.render(createElement(CharacterDetailHero, {
        character: { ...baseCharacter, creator: "Nova", creatorType: "user", creatorId: "user 1" },
      }));
    });
    const link = container.querySelector<HTMLAnchorElement>('a[data-testid="character-detail-creator"]');
    expect(link?.getAttribute("href")).toBe("/creators/user%201");
    expect(link?.textContent).toBe("Nova");

    act(() => root.render(createElement(CharacterDetailHero, { character: baseCharacter })));
    expect(container.querySelector('a[data-testid="character-detail-creator"]')).toBeNull();
  });

  it("pins the hero frame to the card width so min-height cannot widen it past a phone screen", () => {
    act(() => root.render(createElement(CharacterDetailHero, { character: baseCharacter })));
    const frame = container.querySelector<HTMLElement>('[data-testid="character-detail-hero-frame"]');
    // With an auto width, min-h-[440px] transfers through aspect-video into a 782px
    // min-width and the face of a portrait image is cropped off on phones and tablets.
    expect(frame?.className.split(" ")).toEqual(expect.arrayContaining(["aspect-video", "min-h-[440px]", "w-full"]));
  });

  it("shows a cover-only character's whole portrait on desktop instead of zoom-cropping it to 16:9", () => {
    act(() => root.render(createElement(CharacterDetailHero, { character: { ...baseCharacter, heroImage: "/character.png" } })));
    const hero = container.querySelector<HTMLElement>('img[alt="Avery character hero"]');
    expect(hero?.dataset.heroFit).toBe("portrait");
    expect(hero?.className.split(" ")).toEqual(expect.arrayContaining(["lg:object-contain", "lg:object-right"]));
    expect(container.querySelectorAll("img")).toHaveLength(2);

    act(() => root.render(createElement(CharacterDetailHero, { character: { ...baseCharacter, heroImage: "/hero.png" } })));
    const wide = container.querySelector<HTMLElement>('img[alt="Avery character hero"]');
    expect(wide?.dataset.heroFit).toBe("hero");
    expect(wide?.className).not.toContain("object-contain");
    expect(container.querySelectorAll("img")).toHaveLength(1);
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
