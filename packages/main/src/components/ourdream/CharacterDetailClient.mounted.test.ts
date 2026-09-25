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
    character: { title: string; likes: string };
  }) => createElement(
    "section",
    null,
    createElement("h1", null, character.title),
    createElement("p", { "data-testid": "likes" }, `${character.likes} likes`),
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
      if (String(_input) === "/api/v1/chat/sessions") {
        return Response.json(
          { ok: false, error: { code: "forbidden", message: "This Character is unavailable for chat." } },
          { status: 403 },
        );
      }
      const liked = init.method === "POST";
      return Response.json({
        ok: true,
        data: { liked, likesCount: liked ? 1 : 0, likes: liked ? "1" : "0" },
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
    expect(container.querySelector('[data-testid="likes"]')?.textContent).toBe("1 likes");

    await act(async () => findButton("Liked")?.click());
    await waitUntil(() => Boolean(findButton("Like")));
    expect(container.textContent).toContain("Character like removed.");
    expect(container.querySelector('[data-testid="likes"]')?.textContent).toBe("0 likes");
    expect(mutationMethods).toEqual(["POST", "DELETE"]);
  });

  it("shows the server's reason when a chat cannot start", async () => {
    await act(async () =>
      root.render(createElement(CharacterDetailClient, { id: "character-1" }))
    );
    await waitUntil(() => Boolean(findButton("Chat")));
    await act(async () => findButton("Chat")?.click());
    await waitUntil(() => container.textContent?.includes("unavailable for chat") ?? false);
    expect(container.textContent).not.toContain("Could not start chat");
  });

  it("resumes the chat a guest asked for once they come back from signup", async () => {
    window.history.replaceState(null, "", "/characters/character-1?resume=chat");
    await act(async () =>
      root.render(createElement(CharacterDetailClient, { id: "character-1" }))
    );
    await waitUntil(() => mutationMethods.length > 0);
    expect(mutationMethods).toEqual(["POST"]);
    expect(window.location.search).toBe("");
  });

  it("ends with other characters like this one, never the one being viewed", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).startsWith("/api/v1/characters?")) {
        return Response.json({ ok: true, data: {
          items: [character, { ...character, id: "character-2", title: "Blake" }],
          nextCursor: null,
        } });
      }
      return Response.json({ ok: true, data: { character } });
    }));
    await act(async () =>
      root.render(createElement(CharacterDetailClient, { id: "character-1" }))
    );
    await waitUntil(() => Boolean(container.querySelector('[data-testid="character-detail-similar"]')));
    const similar = container.querySelector('[data-testid="character-detail-similar"]')!;
    expect(similar.textContent).toContain("Blake");
    expect(similar.querySelector('a[href="/characters/character-1"]')).toBeNull();
  });

  it("shares a public character through the system share sheet, and offers no Share for a private one", async () => {
    const share = vi.fn(async () => undefined);
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { ...navigator, share, clipboard: { writeText } });
    let visibility = "public";
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: true, data: { character: { ...character, visibility } } })));
    window.history.replaceState(null, "", "/characters/character-1?entryExposureId=e1");
    await act(async () =>
      root.render(createElement(CharacterDetailClient, { id: "character-1" }))
    );
    await waitUntil(() => Boolean(findButton("Share")));
    await act(async () => findButton("Share")?.click());
    expect(share).toHaveBeenCalledWith({ title: "Avery", url: `${window.location.origin}/characters/character-1` });
    expect(writeText).not.toHaveBeenCalled();

    visibility = "private";
    await act(async () =>
      root.render(createElement(CharacterDetailClient, { id: "character-2" }))
    );
    await waitUntil(() => Boolean(findButton("Like")));
    expect(findButton("Share")).toBeUndefined();
  });

  function findButton(label: string) {
    return [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === label,
    );
  }
});
