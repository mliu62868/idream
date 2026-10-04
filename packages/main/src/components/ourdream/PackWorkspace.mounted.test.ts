// @vitest-environment happy-dom
import { act, createElement, StrictMode, type ComponentProps, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PACK_RIGHTS, type PackDetail } from "@idream/shared/packs";

vi.mock("next/link", () => ({ default: ({ href, children, ...props }: ComponentProps<"a">) => createElement("a", { ...props, href: String(href) }, children) }));
vi.mock("next/image", () => ({ default: ({ src, alt }: ComponentProps<"img">) => createElement("img", { src, alt }) }));
vi.mock("./AgeGateBoundary", () => ({ useAgeGateAccess: () => ({ accepted: true }) }));
vi.mock("./PackShell", () => ({ PackShell: ({ children }: { children: ReactNode }) => createElement("main", {}, children) }));
import { PackStudio } from "./PackStudio";
import { PackReader } from "./PackReader";
import { PackCatalog } from "./PackCatalog";
import { invalidateViewerAuthority } from "./viewer-auth";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, container: HTMLDivElement;
beforeEach(() => { invalidateViewerAuthority(); container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); invalidateViewerAuthority(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
function envelope(data: unknown) { return Response.json({ ok: true, data }); }
function viewer(id: string | null = "author-a") { return envelope({ user: id ? { id } : null, anonymousId: "anonymous-a" }); }
function pack(published = false): PackDetail {
  const manifest = { title: "Night album", description: "Only the included current assets.", visibility: "public" as const, coverAssetId: null, claimUntil: null,
    items: [{ mediaAssetId: "image-a", caption: "First image" }, { mediaAssetId: "audio-b", caption: "Second audio" }] };
  return { id: "pack-a", title: manifest.title, description: manifest.description, visibility: manifest.visibility, claimUntil: null, status: published ? "published" : "draft", version: 7,
    creator: { id: "author-a", displayName: "Author" }, itemCount: 2, coverUrl: null, releaseId: published ? "release-a" : null, releaseVersion: published ? 7 : null,
    publishedAt: published ? "2026-10-02T00:00:00.000Z" : null, updatedAt: "2026-10-02T00:00:00.000Z", priceCents: 0, rights: PACK_RIGHTS, canManage: true, canClaim: published,
    manifest, grant: null, grants: [], blockedReason: null,
    release: published ? { id: "release-a", version: 7, title: manifest.title, description: manifest.description, priceCents: 0, rights: PACK_RIGHTS, claimUntil: null, publishedAt: "2026-10-02T00:00:00.000Z", canAccess: true,
      items: manifest.items.map(item => ({ id: item.mediaAssetId, caption: item.caption, type: item.mediaAssetId === "image-a" ? "image" : "voice", contentType: item.mediaAssetId === "image-a" ? "image/png" : "audio/wav", sizeBytes: 1024, url: `/pack/${item.mediaAssetId}`, downloadUrl: `/pack/${item.mediaAssetId}?download=1` })) } : null };
}
function sources() { return envelope({ items: [{ id: "image-a", type: "image", url: "/media/image-a" }, { id: "audio-b", type: "voice", url: "/media/audio-b" }], nextCursor: null }); }
async function until(condition: () => boolean) { for (let i = 0; i < 40; i += 1) { if (condition()) return; await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); } expect(condition()).toBe(true); }
function button(text: string) { return [...container.querySelectorAll("button")].find(item => item.textContent?.trim() === text)!; }
async function click(element: HTMLElement) { expect(element).toBeTruthy(); await act(async () => element.click()); }

describe("Pack authoring, claims and viewer authority", () => {
  it("keeps the same creator's editor usable after a Strict Mode catalog navigation", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/v1/me") return viewer();
      if (path.includes("/sources")) return sources();
      return envelope({ items: [], nextCursor: null });
    }));
    await act(async () => root.render(createElement(StrictMode, {}, createElement(PackCatalog))));
    await until(() => container.textContent?.includes("No public Packs yet") === true);
    await act(async () => root.render(createElement(StrictMode, {}, createElement(PackStudio))));
    await until(() => container.querySelectorAll('input[type="checkbox"]').length === 2);
    expect(container.textContent).not.toContain("signed-in account changed");
    expect(button("Save draft").disabled).toBe(false);
    expect(container.querySelector<HTMLInputElement>('input[maxlength="120"]')?.disabled).toBe(false);
  });
  it("saves reordered current assets with CAS and refuses to publish unsaved changes", async () => {
    const writes: Array<{ path: string; body: unknown; scope: string | null }> = [];
    let saved = pack();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input); if (path === "/api/v1/me") return viewer(); if (path.includes("/sources")) return sources();
      if (init?.method) {
        const body = JSON.parse(String(init.body)); writes.push({ path, body, scope: new Headers(init.headers).get("x-idream-viewer-scope") });
        if (init.method === "PATCH") saved = { ...saved, version: 8, manifest: body.manifest };
        else saved = { ...pack(true), version: 9, manifest: saved.manifest, release: { ...pack(true).release!, version: 9 } };
      }
      return envelope(saved);
    }));
    await act(async () => root.render(createElement(PackStudio, { id: "pack-a" })));
    await until(() => container.querySelectorAll("ol li").length === 2);
    await click(container.querySelector<HTMLButtonElement>('[aria-label="Move asset 2 up"]')!);
    expect(button("Publish saved edition").disabled).toBe(true);
    await click(button("Save draft")); await until(() => container.textContent?.includes("Draft saved.") === true);
    expect(writes[0]).toMatchObject({ path: "/api/v1/packs/pack-a", scope: "user:author-a", body: { version: 7, manifest: { items: [{ mediaAssetId: "audio-b", caption: "Second audio" }, { mediaAssetId: "image-a", caption: "First image" }] } } });
    await click(button("Publish saved edition")); await until(() => container.textContent?.includes("Edition 9 published") === true);
    expect(writes[1]).toMatchObject({ path: "/api/v1/packs/pack-a/publish", body: { version: 8 } });
    expect(container.textContent).toContain("Withdraw this Pack before editing");
  });
  it("names cover options and Gallery picks by position and caption, never by raw media id", async () => {
    const uncaptioned: PackDetail = { ...pack(), manifest: { title: "Night album", description: "", visibility: "public", coverAssetId: null, claimUntil: null,
      items: [{ mediaAssetId: "image-a", caption: "" }, { mediaAssetId: "audio-b", caption: "Second audio" }] } };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input); if (path === "/api/v1/me") return viewer(); if (path.includes("/sources")) return sources();
      return envelope(uncaptioned);
    }));
    await act(async () => root.render(createElement(PackStudio, { id: "pack-a" })));
    await until(() => container.querySelectorAll('input[type="checkbox"]').length === 2);
    const cover = [...container.querySelectorAll("select")].find(select => select.closest("label")?.textContent?.includes("Public preview cover"))!;
    expect([...cover.options].map(option => option.textContent)).toEqual(["No public cover", "1. Image"]);
    const picks = [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].map(input => input.getAttribute("aria-label"));
    expect(picks).toEqual(["Include Gallery image 1", "Include Gallery voice 2"]);
  });
  it("drops a former creator's private editor and ignores a late Gallery result after the account changes", async () => {
    let id = "author-a", finish!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => String(input) === "/api/v1/me" ? viewer(id) : String(input).includes("/sources") ? new Promise<Response>(resolve => { finish = resolve; }) : envelope(pack())));
    await act(async () => root.render(createElement(PackStudio, { id: "pack-a" })));
    await until(() => Boolean(finish) && container.querySelector<HTMLInputElement>("input")?.value === "Night album");
    id = "reader-b"; await act(async () => window.dispatchEvent(new Event("focus")));
    await until(() => container.textContent?.includes("signed-in account changed") === true);
    await act(async () => finish(sources()));
    expect(container.querySelectorAll("input, textarea, select, img")).toHaveLength(0); expect(button("Save draft")).toBeUndefined(); expect(button("Reload editor").disabled).toBe(false);
  });
  it.each([
    { route: "new Pack", id: undefined },
    { route: "saved Pack", id: "pack-a" },
  ])("offers a working full editor reload after the account changes on the $route route", async ({ id }) => {
    let currentViewer = "author-a";
    const reload = vi.spyOn(window.location, "reload").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/v1/me") return viewer(currentViewer);
      if (path.includes("/sources")) return sources();
      return envelope(pack());
    }));
    await act(async () => root.render(createElement(PackStudio, { id })));
    await until(() => container.querySelectorAll('input[type="checkbox"]').length === 2 && !button("Save draft").disabled);
    currentViewer = "reader-b";
    await act(async () => window.dispatchEvent(new Event("focus")));
    await until(() => container.textContent?.includes("signed-in account changed") === true);

    const reloadEditor = button("Reload editor");
    expect(reloadEditor).toBeTruthy();
    expect(reloadEditor.disabled).toBe(false);
    expect(container.querySelectorAll("input, textarea, select, img")).toHaveLength(0);
    await click(reloadEditor);
    expect(reload).toHaveBeenCalledTimes(1);
  });
  it("claims an exact free edition, persists the receipt on refresh, and shows its protected image/audio downloads", async () => {
    let current: PackDetail = { ...pack(true), canManage: false, manifest: null, release: { ...pack(true).release!, canAccess: false, items: pack(true).release!.items.map(item => ({ ...item, url: null, downloadUrl: null })) } };
    const writes: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/v1/me") return viewer("reader-b");
      if (init?.method === "POST") {
        writes.push(JSON.parse(String(init.body))); const grant = { id: "grant-a", releaseId: "release-a", version: 7, title: "Night album", claimedAt: "2026-10-02T00:00:00.000Z", href: "/packs/pack-a?release=release-a" };
        current = { ...current, grant, grants: [grant], release: pack(true).release! };
      }
      return envelope(current);
    }));
    await act(async () => root.render(createElement(PackReader, { id: "pack-a" })));
    await until(() => Boolean(button("Claim free Pack"))); expect(container.querySelector("img")).toBeNull();
    await click(button("Claim free Pack")); await until(() => container.textContent?.includes("Claim receipt: grant-a") === true);
    expect(writes).toEqual([{ releaseId: "release-a", version: 7 }]); expect(container.querySelector("audio")?.getAttribute("src")).toBe("/pack/audio-b");
    expect(container.querySelector('a[href="/pack/image-a?download=1"]')).not.toBeNull();
    await act(async () => root.unmount()); root = createRoot(container);
    await act(async () => root.render(createElement(PackReader, { id: "pack-a", releaseId: "release-a" })));
    await until(() => container.textContent?.includes("Claim receipt: grant-a") === true); expect(writes).toHaveLength(1);
  });
  it("keeps an emergency-blocked receipt visible while removing every asset URL", async () => {
    const grant = { id: "grant-kept", releaseId: "release-a", version: 7, title: "Night album", claimedAt: "2026-10-02T00:00:00.000Z", href: "/packs/pack-a?release=release-a" };
    const blocked = { ...pack(true), status: "blocked", canManage: false, canClaim: false, manifest: null, grant, grants: [grant], blockedReason: "Operator withdrew access.", release: { ...pack(true).release!, canAccess: false, items: pack(true).release!.items.map(item => ({ ...item, url: null, downloadUrl: null })) } };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => String(input) === "/api/v1/me" ? viewer("reader-b") : envelope(blocked)));
    await act(async () => root.render(createElement(PackReader, { id: "pack-a", releaseId: "release-a" })));
    await until(() => container.textContent?.includes("Your existing receipt is retained") === true);
    expect(container.textContent).toContain("Claim receipt: grant-kept");
    expect(container.querySelectorAll("img, audio, video")).toHaveLength(0); expect(container.querySelector('a[href="/packs/pack-a?release=release-a"]')).not.toBeNull(); expect(button("Claim free Pack")).toBeUndefined();
  });
  it("does not invent a claim receipt for a blocked Pack's creator", async () => {
    const blocked = { ...pack(true), status: "blocked", canClaim: false, blockedReason: "Controlled access test.", release: { ...pack(true).release!, canAccess: false, items: pack(true).release!.items.map(item => ({ ...item, url: null, downloadUrl: null })) } };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => String(input) === "/api/v1/me" ? viewer() : envelope(blocked)));
    await act(async () => root.render(createElement(PackReader, { id: "pack-a" })));
    await until(() => container.textContent?.includes("This Pack is blocked.") === true);
    expect(container.textContent).not.toContain("receipt");
    expect(container.querySelectorAll("img, audio, video")).toHaveLength(0);
    expect(container.querySelector('a[href="/packs/pack-a/edit"]')).not.toBeNull();
  });
  it("allows an anonymous public catalog and preserves the release in claimed catalog links", async () => {
    let signedIn = false; const detail = pack(true); const { manifest: _manifest, release: _release, grant: _grant, grants: _grants, blockedReason: _reason, ...summary } = detail;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => String(input) === "/api/v1/me" ? viewer(signedIn ? "reader-b" : null) : envelope({ items: [summary], nextCursor: null })));
    await act(async () => root.render(createElement(PackCatalog)));
    await until(() => container.querySelector('a[href="/packs/pack-a"]') !== null);
    await act(async () => root.unmount()); root = createRoot(container); signedIn = true;
    await act(async () => root.render(createElement(PackCatalog, { scope: "claimed" })));
    await until(() => container.querySelector('a[href="/packs/pack-a?release=release-a"]') !== null);
  });
});
