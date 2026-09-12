// @vitest-environment happy-dom
import { act, createElement, type ComponentProps, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComicDetail } from "@idream/shared/comics";

vi.mock("next/link", () => ({ default: ({ href, children, ...props }: ComponentProps<"a">) => createElement("a", { ...props, href: String(href) }, children) }));
vi.mock("next/image", () => ({ default: ({ src, alt, onError }: ComponentProps<"img">) => createElement("img", { src, alt, onError }) }));
vi.mock("./AgeGateBoundary", () => ({ useAgeGateAccess: () => ({ accepted: true }) }));
vi.mock("./ComicShell", () => ({ ComicShell: ({ children }: { children: ReactNode }) => createElement("main", {}, children) }));
import { ComicReader } from "./ComicReader";
import { ComicStudio } from "./ComicStudio";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;
beforeEach(() => { container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function comic(canManage = true): ComicDetail {
  return {
    id: "comic-a", title: "Night train", description: "An evening journey.", visibility: "public", allowRemix: false,
    status: canManage ? "draft" : "published", version: 7, creator: { id: "author-a", displayName: "Author" },
    pageCount: 2, episodeCount: 1, coverUrl: "/comic/page-a", updatedAt: "2026-09-10T00:00:00.000Z",
    publishedAt: canManage ? null : "2026-09-10T00:00:00.000Z", canManage, reviewNote: null,
    episodes: [{ id: "chapter-a", ordinal: 0, title: "Departure", pages: [
      { id: "page-a", mediaAssetId: "image-a", ordinal: 0, caption: "At the station", url: "/comic/page-a", character: null, remixHref: null },
      { id: "page-b", mediaAssetId: "image-b", ordinal: 1, caption: "On the train", url: "/comic/page-b", character: null, remixHref: null },
    ] }],
  };
}
function envelope(data: unknown) { return Response.json({ ok: true, data }); }
function viewer(id = "author-a") { return envelope({ user: { id, email: `${id}@example.test`, displayName: id, image: null }, ageGate: { accepted: true } }); }
function gallery() { return envelope({ items: ["image-a", "image-b"].map((id) => ({ id, type: "image", url: `/media/${id}`, thumbnailUrl: `/media/${id}`, prompt: "Private generation direction", liked: false })), nextCursor: null }); }
async function until(condition: () => boolean) {
  for (let index = 0; index < 30; index += 1) {
    if (condition()) return;
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
  expect(condition()).toBe(true);
}
function button(label: string) { return [...container.querySelectorAll("button")].find((item) => item.textContent === label)!; }
async function click(target: HTMLButtonElement) { expect(target).toBeTruthy(); await act(async () => target.click()); }

describe("Comic workspace authority and saved order", () => {
  it("reads pages in manifest order and drops revoked content when the reader regains focus", async () => {
    let withdrawn = false;
    vi.stubGlobal("fetch", vi.fn(async () => withdrawn
      ? Response.json({ ok: false, error: { code: "not_found", message: "Comic is no longer available" } }, { status: 404 })
      : envelope(comic(false))));
    await act(async () => root.render(createElement(ComicReader, { id: "comic-a" })));
    await until(() => container.querySelectorAll("figure").length === 2);
    expect([...container.querySelectorAll("figcaption")].map((item) => item.textContent)).toEqual(["At the station", "On the train"]);
    expect(container.querySelector('a[href="/creators/author-a"]')).not.toBeNull();
    withdrawn = true;
    await act(async () => window.dispatchEvent(new Event("focus")));
    await until(() => container.textContent?.includes("Comic is no longer available") === true);
    expect(container.querySelectorAll("img")).toHaveLength(0);
    expect(container.textContent).not.toContain("At the station");
  });

  it("sends the reordered manifest with the loaded version and locks submission until saved", async () => {
    const writes: Array<{ version: number; manifest: { episodes: Array<{ pages: Array<{ mediaAssetId: string }> }> } }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url) === "/api/v1/me") return viewer();
      if (String(url).startsWith("/api/v1/media?")) return gallery();
      if (init?.method === "PATCH") {
        const body = JSON.parse(String(init.body)); writes.push(body);
        const saved = comic(); saved.version = 8; saved.episodes[0]!.pages.reverse();
        return envelope(saved);
      }
      return envelope(comic());
    }));
    await act(async () => root.render(createElement(ComicStudio, { id: "comic-a" })));
    await until(() => Boolean(container.querySelector('button[aria-label="Move page 2 up in chapter 1"]')) && !button("Save draft").disabled);
    await click(container.querySelector<HTMLButtonElement>('button[aria-label="Move page 2 up in chapter 1"]')!);
    expect(button("Submit for review").disabled).toBe(true);
    await click(button("Save draft"));
    await until(() => writes.length === 1 && container.textContent?.includes("Draft saved.") === true);
    expect(writes[0]?.version).toBe(7);
    expect(writes[0]?.manifest.episodes[0]?.pages.map((page) => page.mediaAssetId)).toEqual(["image-b", "image-a"]);
    expect(button("Submit for review").disabled).toBe(false);
    expect(container.textContent).not.toContain("Private generation direction");
  });

  it("does not project an old author's delayed save after focus detects another account", async () => {
    let currentViewer = "author-a";
    let completeSave!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url) === "/api/v1/me") return viewer(currentViewer);
      if (String(url).startsWith("/api/v1/media?")) return gallery();
      if (init?.method === "PATCH") return new Promise<Response>((resolve) => { completeSave = resolve; });
      return envelope(comic());
    }));
    await act(async () => root.render(createElement(ComicStudio, { id: "comic-a" })));
    await until(() => Boolean(container.querySelector('button[aria-label="Move page 2 up in chapter 1"]')) && !button("Save draft").disabled);
    await click(button("Save draft"));
    await until(() => Boolean(completeSave));
    currentViewer = "reader-b";
    await act(async () => window.dispatchEvent(new Event("focus")));
    await until(() => container.textContent?.includes("signed-in account changed") === true);
    await act(async () => completeSave(envelope({ ...comic(), title: "A private saved title", version: 8 })));
    expect(container.textContent).not.toContain("A private saved title");
    expect(container.textContent).not.toContain("At the station");
    expect(container.querySelectorAll("textarea, input, img")).toHaveLength(0);
  });

  it("preserves the same author's unsaved ordering while checking the account on focus", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL) => String(url) === "/api/v1/me" ? viewer() : String(url).startsWith("/api/v1/media?") ? gallery() : envelope(comic())));
    await act(async () => root.render(createElement(ComicStudio, { id: "comic-a" })));
    await until(() => Boolean(container.querySelector('button[aria-label="Move page 2 up in chapter 1"]')) && !button("Save draft").disabled);
    await click(container.querySelector<HTMLButtonElement>('button[aria-label="Move page 2 up in chapter 1"]')!);
    await act(async () => window.dispatchEvent(new Event("focus")));
    await until(() => container.querySelectorAll("textarea").length === 3);
    expect([...container.querySelectorAll("textarea")].map((item) => item.value)).toEqual(["An evening journey.", "On the train", "At the station"]);
    expect(button("Submit for review").disabled).toBe(true);
  });

  it("stops guarding a saved new draft before synchronously navigating to its editor", async () => {
    let preventedDuringNavigation: boolean | undefined;
    const navigate = vi.spyOn(window.location, "assign").mockImplementation(() => {
      const event = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(event); preventedDuringNavigation = event.defaultPrevented;
    });
    vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url) === "/api/v1/me") return viewer();
      if (String(url).startsWith("/api/v1/media?")) return gallery();
      if (init?.method === "POST") return envelope(comic());
      throw new Error(`Unexpected request ${String(url)}`);
    }));
    await act(async () => root.render(createElement(ComicStudio)));
    await until(() => Boolean(container.querySelector('button[aria-label="Add Gallery image 1 to chapter 1"]')));
    const title = container.querySelector<HTMLInputElement>('input[placeholder="Give your story a title"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(title, "Night train");
      title.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click(container.querySelector<HTMLButtonElement>('button[aria-label="Add Gallery image 1 to chapter 1"]')!);
    const unsaved = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(unsaved);
    expect(unsaved.defaultPrevented).toBe(true);
    await click(button("Save draft"));
    await until(() => navigate.mock.calls.length === 1);
    expect(navigate).toHaveBeenCalledWith("/creator-studio/comics/comic-a");
    expect(preventedDuringNavigation).toBe(false);
  });
});
