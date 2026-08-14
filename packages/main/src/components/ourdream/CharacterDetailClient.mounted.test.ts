// @vitest-environment happy-dom

import { act, createElement, type ComponentProps, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: ComponentProps<"a">) =>
    createElement(
      "a",
      { href: typeof href === "string" ? href : String(href), ...props },
      children,
    ),
}));
vi.mock("./AgeGateBoundary", () => ({
  useAgeGateAccess: () => ({ accepted: true }),
}));
vi.mock("./AppSidebar", () => ({ AppSidebar: () => null }));
vi.mock("./MobileBottomNav", () => ({ MobileBottomNav: () => null }));
vi.mock("./SiteFooter", () => ({ SiteFooter: () => null }));
vi.mock("./CharacterDetailHero", () => ({
  CharacterDetailHero: ({ actions, character }: {
    actions: ReactNode;
    character: { title: string };
  }) => createElement(
    "section",
    null,
    createElement("h1", null, character.title),
    actions,
  ),
}));

import { CharacterDetailClient } from "./CharacterDetailClient";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const character = {
  id: "character-1",
  title: "Avery",
  age: "24",
  description: "A public character.",
  likes: "0",
  chats: "0",
  creator: "Official",
  image: "/character.png",
  liked: false,
};

async function waitUntil(predicate: () => boolean) {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for character detail: ${document.body.textContent}`);
    }
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  }
}

describe("CharacterDetailClient like relationship", () => {
  let container: HTMLDivElement;
  let root: Root;
  const mutationMethods: string[] = [];

  beforeEach(() => {
    mutationMethods.length = 0;
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (!init?.method) {
        return Response.json({ ok: true, data: { character } });
      }
      mutationMethods.push(init.method);
      return Response.json({
        ok: true,
        data: { liked: init.method === "POST" },
      });
    }));
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("toggles the persisted relationship with POST then DELETE", async () => {
    await act(async () =>
      root.render(createElement(CharacterDetailClient, { id: "character-1" }))
    );
    await waitUntil(() => Boolean(findButton("Like")));

    await act(async () => findButton("Like")?.click());
    await waitUntil(() => Boolean(findButton("Liked")));
    expect(container.textContent).toContain("Character liked.");

    await act(async () => findButton("Liked")?.click());
    await waitUntil(() => Boolean(findButton("Like")));
    expect(container.textContent).toContain("Character like removed.");
    expect(mutationMethods).toEqual(["POST", "DELETE"]);
  });

  function findButton(label: string) {
    return [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === label,
    );
  }
});
