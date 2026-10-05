// @vitest-environment happy-dom

import { act, createElement, StrictMode, type ComponentProps, type ReactNode } from "react";
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
import { invalidateViewerAuthority } from "./viewer-auth";

const viewerResponse = (input: RequestInfo | URL) => String(input) === "/api/v1/me"
  ? Response.json({ ok: true, data: { user: { id: "owner-a" } } }) : null;
vi.mock("./AppTopbar", () => ({ AppTopbar: () => null }));

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
    invalidateViewerAuthority();
    window.history.replaceState(null, "", "/characters/character-1");
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const viewer = viewerResponse(_input);
      if (viewer) return viewer;
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
    invalidateViewerAuthority();
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
      const viewer = viewerResponse(input);
      if (viewer) return viewer;
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
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => viewerResponse(input) ?? Response.json({
      ok: true,
      data: { character: { ...character, visibility, shareable: visibility === "public" } },
    })));
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
    expect(document.querySelector('[data-testid="character-detail-publication"]')).toBeNull();
  });

  it("tells the owner a public character awaits publication instead of copying a link visitors cannot open", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => viewerResponse(input) ?? Response.json({
      ok: true,
      data: { character: { ...character, visibility: "public", publicationState: "awaiting_publication", shareable: false } },
    })));
    await act(async () =>
      root.render(createElement(CharacterDetailClient, { id: "character-1" }))
    );
    await waitUntil(() => Boolean(findButton("Like")));
    expect(findButton("Share")).toBeUndefined();
    const notice = document.querySelector('[data-testid="character-detail-publication"]');
    expect(notice?.textContent).toContain("Awaiting publication");
    expect(notice?.textContent).toContain("Only you can see this page");
    expect(notice?.textContent).not.toMatch(/minute|hour|day|soon/i);
  });

  it("offers Hear voice only for a Character with a voice, and plays it on click without autoplay", async () => {
    let release: () => void = () => undefined;
    const sampleFetches: string[] = [];
    let voiceSampleAvailable = true;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const viewer = viewerResponse(input);
      if (viewer) return viewer;
      const url = String(input);
      if (url.endsWith("/voice-sample")) {
        sampleFetches.push(url);
        await new Promise<void>((resolve) => { release = resolve; });
        return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "audio/mpeg" } });
      }
      return Response.json({ ok: true, data: { character: { ...character, voiceSampleAvailable } } });
    }));
    const played: HTMLAudioElement[] = [];
    const createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:sample");
    const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(async function (this: HTMLAudioElement) {
      played.push(this);
    });
    const pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    try {
      await act(async () =>
        root.render(createElement(CharacterDetailClient, { id: "character-1" }))
      );
      await waitUntil(() => Boolean(findButton("Hear voice")));
      expect(sampleFetches).toEqual([]);
      expect(play).not.toHaveBeenCalled();

      await act(async () => findButton("Hear voice")?.click());
      await waitUntil(() => Boolean(findButton("Loading voice...")));
      await act(async () => release());
      await waitUntil(() => Boolean(findButton("Stop voice")));
      expect(sampleFetches).toEqual(["/api/v1/characters/character-1/voice-sample"]);
      expect(played).toHaveLength(1);

      await act(async () => findButton("Stop voice")?.click());
      expect(pause).toHaveBeenCalled();
      await waitUntil(() => Boolean(findButton("Hear voice")));
      await act(async () => findButton("Hear voice")?.click());
      await waitUntil(() => Boolean(findButton("Stop voice")));
      await act(async () => played[1]?.onended?.(new Event("ended")));
      await waitUntil(() => Boolean(findButton("Hear voice")));
      // The fetched sample is reused; replay never asks the server again.
      expect(sampleFetches).toHaveLength(1);

      voiceSampleAvailable = false;
      await act(async () =>
        root.render(createElement(CharacterDetailClient, { id: "character-2" }))
      );
      await waitUntil(() => Boolean(findButton("Like")));
      expect(findButton("Hear voice")).toBeUndefined();
    } finally {
      play.mockRestore();
      pause.mockRestore();
      createObjectURL.mockRestore();
    }
  });

  it("returns to Hear voice with a status message when the sample cannot load", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => viewerResponse(input) ?? (String(input).endsWith("/voice-sample")
      ? Response.json({ ok: false, error: { code: "not_found", message: "Character has no voice sample" } }, { status: 404 })
      : Response.json({ ok: true, data: { character: { ...character, voiceSampleAvailable: true } } }))));
    await act(async () =>
      root.render(createElement(CharacterDetailClient, { id: "character-1" }))
    );
    await waitUntil(() => Boolean(findButton("Hear voice")));
    await act(async () => findButton("Hear voice")?.click());
    await waitUntil(() => container.textContent?.includes("Could not play this voice sample") ?? false);
    expect(findButton("Hear voice")).toBeDefined();
  });

  function findButton(label: string) {
    return [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === label,
    );
  }
});


describe("CharacterDetailClient viewer lifecycle", () => {
  let root: Root, container: HTMLDivElement, viewer: string | null;
  const ok = (data: unknown) => Response.json({ ok: true, data });
  const button = (label: string) => [...container.querySelectorAll("button")].find(item => item.textContent?.trim() === label);
  const read = (input: RequestInfo | URL) => {
    const path = String(input);
    if (path === "/api/v1/me") return ok({ user: viewer ? { id: viewer } : null });
    if (path.startsWith("/api/v1/characters?")) return ok({ items: [], nextCursor: null });
    return ok({ character: { ...character, name: `Private ${viewer}`, title: `Private ${viewer}`, liked: viewer === "owner-a" } });
  };
  async function settle() { for (let i = 0; i < 8; i += 1) await act(async () => new Promise(resolve => setTimeout(resolve, 0))); }
  async function mount() { await act(async () => root.render(createElement(CharacterDetailClient, { id: "character-1" }))); await settle(); }
  beforeEach(() => { viewer = "owner-a"; invalidateViewerAuthority(); window.history.replaceState(null, "", "/characters/character-1?journeyId=j1"); container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); invalidateViewerAuthority(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("drops the private character and its title when the new account cannot read it", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => String(input) === "/api/v1/characters/character-1" && viewer === "owner-b"
      ? Response.json({ ok: false }, { status: 404 }) : read(input)));
    await mount(); expect(container.textContent).toContain("Private owner-a"); expect(document.title).toContain("Private owner-a");
    viewer = "owner-b"; await act(async () => window.dispatchEvent(new Event("focus"))); await settle();
    expect(container.textContent).not.toContain("Private owner-a"); expect(document.title).not.toContain("Private owner-a");
    expect(container.textContent).toContain("could not be found"); expect(button("Chat")).toBeUndefined();
  });
  it("refreshes the like relationship for the confirmed account", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => read(input)));
    await mount(); expect(button("Liked")).toBeDefined(); viewer = "owner-b";
    await act(async () => window.dispatchEvent(new Event("focus"))); await settle();
    expect(button("Like")).toBeDefined(); expect(button("Liked")).toBeUndefined();
  });
  it.each(["Chat", "Liked"])("refuses a previous account's %s intent before focus", async label => {
    const writes: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => { if (init?.method) { writes.push(viewer!); return ok({ liked: false, session: { id: "wrong-owner" } }); } return read(input); }));
    await mount(); viewer = "owner-b"; await act(async () => button(label)!.click()); await settle();
    expect(writes).toEqual([]);
  });
  it("does not project an old account's late like receipt", async () => {
    let finish!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => init?.method ? new Promise<Response>(resolve => { finish = resolve; }) : read(input)));
    await mount(); await act(async () => button("Liked")!.click()); await settle(); expect(finish).toBeDefined();
    viewer = "owner-b"; await act(async () => window.dispatchEvent(new Event("focus"))); await settle();
    await act(async () => finish(ok({ liked: true, likesCount: 999, likes: "999" }))); await settle();
    expect(button("Like")).toBeDefined(); expect(container.textContent).not.toContain("999"); expect(container.textContent).not.toContain("Character liked.");
  });
  it.each(["Chat", "Like"])("keeps a guest's %s target through signup without an account write", async label => {
    viewer = null; const writes: string[] = []; const navigate = vi.spyOn(window.location, "assign").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => { if (init?.method) { writes.push(String(input)); viewer = "owner-b"; return ok({ liked: true }); } return read(input); }));
    await mount(); expect(button(label)).toBeDefined(); await act(async () => button(label)!.click()); await settle();
    expect(writes).toEqual([]); expect(navigate).toHaveBeenCalledWith(`/signup?next=${encodeURIComponent(`/characters/character-1?journeyId=j1${label === "Chat" ? "&resume=chat" : ""}`)}`);
  });
  it("offers effective retry when the initial account confirmation fails", async () => {
    let unavailable = true; const reads: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => { if (String(input) === "/api/v1/me" && unavailable) return Response.json({ ok: false }, { status: 503 }); reads.push(String(input)); return read(input); }));
    await mount(); expect(button("Chat")).toBeUndefined(); expect(reads).toEqual([]); expect(button("Retry")).toBeDefined();
    unavailable = false; await act(async () => button("Retry")!.click()); await settle(); expect(button("Chat")).toBeDefined();
  });
  it("sends a same-account like with a fixed scope and uses the authority result", async () => {
    const scopes: Array<string | null> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => { if (init?.method) { scopes.push(new Headers(init.headers).get("x-idream-viewer-scope")); return ok({ liked: false, likesCount: 7, likes: "7" }); } return read(input); }));
    await mount(); await act(async () => button("Liked")!.click()); await settle();
    expect(scopes).toEqual(["user:owner-a"]); expect(button("Like")).toBeDefined(); expect(container.textContent).toContain("7 likes");
  });
  it("does not play a private voice sample that arrives after the owner changes", async () => {
    let finish!: (response: Response) => void;
    const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    const objectUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:old-owner");
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/voice-sample")) return new Promise<Response>(resolve => { finish = resolve; });
      if (String(input) === "/api/v1/characters/character-1" && viewer === "owner-b") return Response.json({ ok: false }, { status: 404 });
      const response = read(input); const payload = await response.json();
      if (payload.data.character) payload.data.character.voiceSampleAvailable = true;
      return Response.json(payload);
    }));
    await mount(); await act(async () => button("Hear voice")!.click()); await settle(); expect(finish).toBeDefined();
    viewer = "owner-b"; await act(async () => window.dispatchEvent(new Event("focus"))); await settle();
    await act(async () => finish(new Response(new Uint8Array([1, 2, 3])))); await settle();
    expect(play).not.toHaveBeenCalled(); expect(objectUrl).not.toHaveBeenCalled(); expect(button("Hear voice")).toBeUndefined();
  });
  it("restores Hear voice and reports an account confirmation failure without requesting audio", async () => {
    let unavailable = false; const samples: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/v1/me" && unavailable) return Response.json({ ok: false }, { status: 503 });
      if (String(input).endsWith("/voice-sample")) { samples.push(String(input)); return new Response(); }
      const response = read(input); const payload = await response.json();
      if (payload.data.character) payload.data.character.voiceSampleAvailable = true;
      return Response.json(payload);
    }));
    await mount(); unavailable = true; await act(async () => button("Hear voice")!.click()); await settle();
    expect(samples).toEqual([]); expect(button("Hear voice")).toBeDefined(); expect(container.textContent).toContain("Could not play this voice sample");
  });
  it("does not navigate from a chat response whose body resolves after the owner changes", async () => {
    let finishBody!: (value: unknown) => void;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method) { const response = ok({}); vi.spyOn(response, "json").mockImplementation(() => new Promise(resolve => { finishBody = resolve; })); return response; }
      return read(input);
    }));
    await mount(); await act(async () => button("Chat")!.click()); await settle(); expect(finishBody).toBeDefined();
    viewer = "owner-b"; await act(async () => window.dispatchEvent(new Event("focus"))); await settle();
    await act(async () => finishBody({ ok: true, data: { session: { id: "old-owner-session" } } })); await settle();
    expect(window.location.pathname).toBe("/characters/character-1");
  });

  it("plays the first voice sample after StrictMode remounts effects", async () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:strict-sample");
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/voice-sample")) return new Response(new Uint8Array([1, 2, 3]));
      const response = read(input); const payload = await response.json();
      if (payload.data.character) payload.data.character.voiceSampleAvailable = true;
      return Response.json(payload);
    }));
    await act(async () => root.render(createElement(StrictMode, null, createElement(CharacterDetailClient, { id: "character-1" })))); await settle();
    expect(button("Hear voice")).toBeDefined(); await act(async () => button("Hear voice")!.click()); await settle();
    expect(play).toHaveBeenCalledOnce(); expect(button("Stop voice")).toBeDefined();
  });

  it("keeps the successful report visible while confirmation refreshes the character", async () => {
    let delayed = false; const completeReads: Array<(response: Response) => void> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST" && String(input).endsWith("/report")) return ok({ report: { id: "confirmed-report" } });
      if (delayed && String(input) === "/api/v1/characters/character-1") return new Promise<Response>(resolve => { completeReads.push(resolve); });
      return read(input);
    }));
    await mount(); delayed = true;
    await act(async () => button("Report")!.click()); await act(async () => button("Submit report")!.click()); await settle();
    expect(container.textContent).toContain("Report submitted."); expect(container.querySelector('[role="dialog"]')).toBeNull(); expect(completeReads.length).toBeGreaterThan(0);
    await act(async () => completeReads.forEach(finish => finish(read("/api/v1/characters/character-1")))); await settle();
    expect(container.textContent).toContain("Report submitted.");
  });

  it("shows a later read failure alongside the prior report confirmation", async () => {
    let unavailable = false;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST" && String(input).endsWith("/report")) return ok({ report: { id: "confirmed-report" } });
      if (unavailable && String(input) === "/api/v1/characters/character-1") return Response.json({ ok: false }, { status: 503 });
      return read(input);
    }));
    await mount(); await act(async () => button("Report")!.click()); await act(async () => button("Submit report")!.click()); await settle();
    expect(container.textContent).toContain("Report submitted."); unavailable = true;
    await act(async () => window.dispatchEvent(new Event("focus"))); await settle();
    expect(container.textContent).toContain("Report submitted."); expect(container.textContent).toContain("Could not load this character."); expect(button("Retry")).toBeDefined();
  });

});
