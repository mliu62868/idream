// @vitest-environment happy-dom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminI18nProvider } from "@/components/admin/i18n";
import { CharacterImageLibrary } from "./CharacterImageLibrary";
import { CharacterVideoLibrary } from "./CharacterVideoLibrary";
import { characterWorkspaceDetail } from "./character-workspace-fixture";
import { CharacterWorkspace } from "./CharacterWorkspace";
import type { AdminPermissionKey } from "@idream/shared/admin";

const { request, get } = vi.hoisted(() => ({ request: vi.fn(), get: vi.fn() }));
vi.mock("@/lib/admin-v2-api", async importOriginal => ({ ...await importOriginal<typeof import("@/lib/admin-v2-api")>(), adminV2Request: (...args: unknown[]) => request(...args) }));
vi.mock("@/components/admin/api", () => ({ apiGet: (...args: unknown[]) => get(...args) }));
vi.mock("next/image", () => ({ default: ({ src }: { src: string }) => <span data-image-src={src} /> }));
vi.mock("./CharacterAssetStudio", () => ({ CharacterAssetStudio: () => <span /> }));
vi.mock("./CharacterVideoStudio", () => ({ CharacterVideoStudio: () => <span /> }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const source = { id: "chat-setup-source", url: "/user-content/chat-setup-source/content.png", thumbnailUrl: null, filename: "source.png", contentType: "image/png", sizeBytes: 2048, width: 32, height: 48, createdAt: "2026-10-29T12:00:00.000Z", qualification: null };
const result = { items: [], nextCursor: null, capabilities: { describe: true, search: true }, visualIdentity: { visualProfileId: "visual-fixture", visualProfileVersion: 1 },
  serving: null, coverage: { production: { published: 0, hasEligibleMedia: false }, serving: null } };
async function waitUntil(predicate: () => boolean) {
  const deadline = Date.now() + 2_000;
  while (!predicate()) { if (Date.now() >= deadline) throw new Error("Chat source click did not open its editor"); await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); }
}

describe.each(["image", "video"] as const)("real %s library to chat editor interaction", mediaType => {
  let container: HTMLDivElement; let root: Root;
  beforeEach(() => {
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    request.mockReset(); get.mockReset(); window.localStorage.clear();
    request.mockImplementation(async (path: string) => {
      if (path.includes("/media-library")) return result;
      if (path.includes("/image-sources")) return { items: [source], nextCursor: null };
      throw new Error(`Unexpected request ${path}`);
    });
    get.mockResolvedValue({ items: [{ ...source, type: "video", platformStatus: "generated", sourceJob: null, tags: [] }], nextCursor: null });
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
  it("loads the clicked source and opens the real child editor", async () => {
    const data = characterWorkspaceDetail({ visual: { identityBootstrap: { allowed: false } } });
    await act(async () => root.render(<StrictMode><AdminI18nProvider locale="en">{mediaType === "image"
      ? <CharacterImageLibrary actorId="operator" data={data} canRead canReadProduction canCreate canPublish canArchive={false} onContinue={() => undefined} onProjectReload={async () => undefined} commitProjectMutation={async ({ commit }) => ({ result: await commit(), refreshed: true })} />
      : <CharacterVideoLibrary actorId="operator" data={data} canRead canReadProduction canCreate canImport canPublish canArchive={false} onCreateImage={() => undefined} onProjectReload={async () => undefined} runCommittedMutation={async ({ commit }) => ({ result: await commit(), refreshed: true })} />
    }</AdminI18nProvider></StrictMode>));
    await waitUntil(() => [...container.querySelectorAll("button")].some(button => button.textContent === "Set up chat content"));
    const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Set up chat content")!;
    expect(button.disabled).toBe(false);
    await act(async () => button.click());
    await waitUntil(() => request.mock.calls.some(([path]) => new URL(path, "http://admin.test").searchParams.get("sourceAssetId") === source.id));
    await waitUntil(() => !!container.querySelector('[aria-label="Chat description editor"]'));
    expect(container.querySelector('[aria-label="Chat description editor"] textarea')).not.toBeNull();
    expect(request.mock.calls.filter(([path]) => new URL(path, "http://admin.test").searchParams.get("sourceAssetId") === source.id)).toHaveLength(1);
  });

  it("opens chat content from the full Character workspace with its real ancestor handlers", async () => {
    const data = characterWorkspaceDetail({ visual: { identityBootstrap: { allowed: false } } });
    const tab = mediaType === "image" ? "assets" : "video";
    window.history.replaceState(null, "", `/admin/characters/${data.character.id}?tab=${tab}`);
    const original = request.getMockImplementation()!;
    request.mockImplementation(async (path: string, ...args: unknown[]) => {
      if (path === `/api/v2/admin/characters/${data.character.id}`) return data;
      if (path.includes("/collaboration/")) return { items: [], actors: [], watcherIds: [], pageInfo: { endCursor: null, hasNextPage: false } };
      if (path.includes("/creative/runs?")) return { items: [], pageInfo: { endCursor: null, hasNextPage: false } };
      return original(path, ...args);
    });
    const permissions = new Set<AdminPermissionKey>(["character.project.read", "character.release.read", "character.performance.read", "character.project.write", "character.release.publish", "creative.run.read", "creative.run.write", "creative.run.review", "creative.asset.read", "content.asset.read"]);
    await act(async () => root.render(<StrictMode><AdminI18nProvider locale="en"><CharacterWorkspace actorId="operator" permissions={permissions} view={{ kind: "detail", id: data.character.id }} /></AdminI18nProvider></StrictMode>));
    await waitUntil(() => [...container.querySelectorAll("button")].some(button => button.textContent === "Set up chat content"));
    const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Set up chat content")!;
    await act(async () => button.click());
    await waitUntil(() => request.mock.calls.some(([path]) => new URL(path, "http://admin.test").searchParams.get("sourceAssetId") === source.id));
    await waitUntil(() => !!container.querySelector('[aria-label="Chat description editor"]'));
  });
});
