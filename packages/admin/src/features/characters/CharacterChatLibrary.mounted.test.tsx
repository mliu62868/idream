// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CharacterMediaLibraryEntry, CharacterMediaLibraryListResponse } from "@idream/shared/admin";
import { AdminV2RequestError } from "@/lib/admin-v2-api";
import { CharacterChatLibrary } from "./CharacterChatLibrary";

const { operation } = vi.hoisted(() => ({ operation: vi.fn() }));
vi.mock("@/lib/admin-v2-operation", () => ({ adminV2Operation: (...args: unknown[]) => operation(...args) }));
vi.mock("next/image", () => ({ default: ({ src }: { src: string }) => <span data-image-src={src} /> }));
vi.mock("@/components/admin/i18n", () => {
  const context = { t: (value: string, values?: Record<string, string | number>) => Object.entries(values ?? {}).reduce((text, [key, replacement]) => text.replaceAll(`{${key}}`, String(replacement)), value) };
  return { useAdminI18n: () => context };
});
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const source = { id: "asset-1", url: "/uploads/source.webp", thumbnailUrl: null };
function entry(status: CharacterMediaLibraryEntry["status"] = "draft"): CharacterMediaLibraryEntry {
  return { id: "entry-1", characterId: "character-1", sourceAssetId: source.id, mediaType: "image", visualProfileId: "visual-1", visualProfileVersion: 3,
    revision: 2, status, description: "Wearing a blue jacket by the window", facts: ["blue jacket", "window"], absentFacts: ["hat"], nudity: "none", descriptionSource: "operator", sourceSha256: "a".repeat(64),
    url: "/api/v2/admin/characters/character-1/media-library/entry-1/content", thumbnailUrl: "/api/v2/admin/characters/character-1/media-library/entry-1/content?thumbnail=1", width: 640, height: 960, durationSeconds: null, hasAudio: null,
    createdAt: "2026-10-29T12:00:00.000Z", updatedAt: "2026-10-29T12:00:00.000Z" };
}
function library(items: CharacterMediaLibraryEntry[] = []): CharacterMediaLibraryListResponse {
  const published = items.filter(item => item.status === "published").length;
  return { items, nextCursor: null, capabilities: { describe: true, search: true }, visualIdentity: { visualProfileId: "visual-1", visualProfileVersion: 3 },
    serving: null, coverage: { production: { published, hasEligibleMedia: published > 0 }, serving: null } };
}
async function waitUntil(predicate: () => boolean) {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for chat media editor");
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  }
}

describe("Character chat library", () => {
  let root: Root; let container: HTMLDivElement;
  let current: CharacterMediaLibraryEntry | null;
  beforeEach(() => {
    container = document.createElement("div"); document.body.append(container); root = createRoot(container); current = null;
    operation.mockReset();
    operation.mockImplementation(async (id, options) => {
      if (id.startsWith("GET ")) return library(current ? [current] : []);
      if (id.endsWith("/describe")) return { description: "A visible jacket at the window", facts: ["jacket", "window"], absentFacts: ["hat"], nudity: "none", sourceSha256: "a".repeat(64), model: "vision-test" };
      if (id.endsWith("/search-preview")) return { matches: [], elapsedMs: 12 };
      current = { ...entry(), ...(current ?? {}), ...options.body, revision: (current?.revision ?? 0) + 1 };
      return { entry: current, replayed: false };
    });
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
  async function render(canPublish = true, canWrite = true) {
    await act(async () => root.render(<CharacterChatLibrary characterId="character-1" mediaType="image" canWrite={canWrite} canPublish={canPublish} source={source} onCloseSource={() => undefined} />));
    await waitUntil(() => !!container.querySelector('[aria-label="Chat description editor"]'));
  }
  function button(text: string) { return [...container.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent?.trim() === text)!; }
  function textarea(text: string) { return [...container.querySelectorAll("label")].find(node => node.textContent?.startsWith(text))!.querySelector<HTMLTextAreaElement>("textarea")!; }
  async function edit(control: HTMLTextAreaElement | HTMLInputElement, value: string) {
    await act(async () => {
      const prototype = control.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(control, value);
      control.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  async function click(text: string) { await act(async () => button(text).click()); }
  async function choose(label: string, value: string) {
    const select = [...container.querySelectorAll("label")].find(node => node.textContent?.startsWith(label))!.querySelector("select")!;
    await act(async () => { select.value = value; select.dispatchEvent(new Event("change", { bubbles: true })); });
  }

  it("lets an operator correct recognized content and saves identity pins plus facts before enabling chat", async () => {
    await render();
    await waitUntil(() => !button("Recognize visible content").disabled);
    await click("Recognize visible content");
    expect(textarea("Visible content description").value).toBe("A visible jacket at the window");
    await edit(textarea("Visible content description"), "A blue jacket beside a closed window");
    await edit(textarea("Visible facts, one per line"), "blue jacket\nclosed window\nblue jacket");
    await click("Save draft");
    const save = operation.mock.calls.find(([id]) => id === "POST /api/v2/admin/characters/:id/media-library")!;
    expect(save[1].body).toEqual({ sourceAssetId: "asset-1", expectedVisualProfileId: "visual-1", expectedVisualProfileVersion: 3,
      description: "A blue jacket beside a closed window", facts: ["blue jacket", "closed window"], absentFacts: ["hat"], nudity: "none", status: "draft" });
    expect(container.textContent).toContain("Chat description saved");
    expect(container.querySelector('[aria-label="Chat description editor"] [data-image-src]')?.getAttribute("data-image-src")).toBe(entry().url);
    await click("Use in chat");
    expect(operation.mock.calls.findLast(([id]) => id.startsWith("PATCH "))?.[1].body).toMatchObject({ expectedRevision: 1, status: "published" });
    expect(container.textContent).toContain("Chat media enabled for this identity");
  });

  it.each(["published", "withdrawn"] as const)("keeps %s content read-only without release permission", async status => {
    current = entry(status);
    await render(false);
    expect(textarea("Visible content description").disabled).toBe(true);
    expect(button("Save description").disabled).toBe(true);
    expect(button(status === "published" ? "Withdraw from chat" : "Use in chat").disabled).toBe(true);
    await click("Save description");
    expect(operation.mock.calls.filter(([id]) => !id.startsWith("GET "))).toHaveLength(0);
  });

  it("updates a live descriptor with the current revision and withdraws the returned revision", async () => {
    current = entry("published");
    await render();
    await edit(textarea("Visible content description"), "Verified blue jacket and closed window");
    await click("Save description");
    expect(operation.mock.calls.find(([id]) => id.startsWith("PATCH "))?.[1].body).toMatchObject({ expectedRevision: 2, description: "Verified blue jacket and closed window" });
    await click("Withdraw from chat");
    expect(operation.mock.calls.findLast(([id]) => id.startsWith("PATCH "))?.[1].body).toMatchObject({ expectedRevision: 3, status: "withdrawn" });
    expect(container.textContent).toContain("Media withdrawn from chat");
  });

  it("preserves the operator description after a rejected stale revision", async () => {
    current = entry(); await render();
    operation.mockImplementation(async (id) => {
      if (id.startsWith("GET ")) return library([entry()]);
      throw new AdminV2RequestError("This chat library item has changed; reload it before saving", 409, "conflict");
    });
    await edit(textarea("Visible content description"), "My reviewed description remains here");
    await click("Save description");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Chat description could not be saved");
    expect(textarea("Visible content description").value).toBe("My reviewed description remains here");
    expect(button("Save description").disabled).toBe(false);
    current = { ...entry(), revision: 3, description: "Current server description" };
    operation.mockImplementation(async () => library([current!]));
    await click("Discard edits and reload");
    await waitUntil(() => !!container.querySelector('[aria-label="Chat description editor"]'));
    expect(textarea("Visible content description").value).toBe("Current server description");
  });

  it("withdraws the saved version without requiring or saving incomplete editor changes", async () => {
    current = entry("published"); await render();
    await edit(textarea("Visible content description"), "");
    expect(button("Save description").disabled).toBe(true);
    expect(button("Withdraw from chat").disabled).toBe(false);
    await click("Withdraw from chat");
    expect(operation.mock.calls.find(([id]) => id.startsWith("PATCH "))?.[1].body).toEqual({ expectedRevision: 2, status: "withdrawn" });
  });

  it("sends explicit search constraints and renders no-match evidence", async () => {
    await render();
    await waitUntil(() => !container.textContent?.includes("Chat media search is unavailable."));
    const query = [...container.querySelectorAll("label")].find(node => node.textContent?.startsWith("Example chat request"))!.querySelector("input")!;
    await edit(query, "Show me the blue jacket by the window");
    await edit(textarea("Required facts, one per line"), "blue jacket\nwindow");
    await edit(textarea("Excluded facts, one per line"), "hat");
    await click("Find matching chat media");
    expect(operation.mock.calls.find(([id]) => id.endsWith("/search-preview"))?.[1].body).toEqual({ mediaType: "image", visualIdentity: library().visualIdentity,
      query: "Show me the blue jacket by the window", requiredFacts: ["blue jacket", "window"], excludedFacts: ["hat"], nudity: "unspecified" });
    expect(container.textContent).toContain("0 matches in 12 ms");
  });

  it("does not allow a missing visual identity to create a library entry", async () => {
    operation.mockImplementation(async () => ({ ...library(), visualIdentity: null }));
    await render();
    await edit(textarea("Visible content description"), "A verified portrait with a jacket");
    expect(button("Save draft").disabled).toBe(true);
    expect(button("Use in chat").disabled).toBe(true);
    expect(container.textContent).toContain("Set the Character visual identity");
  });

  describe("after another visual identity is activated", () => {
    const currentIdentity = { visualProfileId: "visual-2", visualProfileVersion: 4 };
    const v1 = (status: CharacterMediaLibraryEntry["status"] = "published") => ({ ...entry(status), id: "entry-v1" });
    const v2 = () => ({ ...entry("published"), id: "entry-v2", ...currentIdentity, description: "Described for the current identity" });
    const posted = () => operation.mock.calls.filter(([id]) => id === "POST /api/v2/admin/characters/:id/media-library");
    const patched = () => operation.mock.calls.filter(([id]) => String(id).startsWith("PATCH "));
    const grid = () => [...container.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent?.includes("Wearing a blue jacket"))!;
    const live = { releaseId: "release-v1", visualIdentity: library().visualIdentity };
    const mockList = (items: CharacterMediaLibraryEntry[], serving: CharacterMediaLibraryListResponse["serving"] = null) => {
      operation.mockImplementation(async (id, options) => {
        if (id.startsWith("GET ")) return { ...library(items), visualIdentity: currentIdentity, serving,
          coverage: { production: { published: 0, hasEligibleMedia: false }, serving: serving ? { published: 1, hasEligibleMedia: true } : null } };
        if (id.endsWith("/search-preview")) return { matches: [], elapsedMs: 1 };
        const target = items.find(item => item.id === options.path.entryId) ?? v2();
        return { entry: { ...target, ...options.body, revision: target.revision + 1 }, replayed: false };
      });
    };

    it("creates for the production identity only after explicitly selecting it from the source", async () => {
      mockList([v1()]);
      await render();
      expect(textarea("Visible content description").value).toBe(v1().description);
      expect(textarea("Visible content description").disabled).toBe(true);
      await choose("Visual identity for this media", "visual-2");
      expect(button("Save draft")).toBeDefined();
      expect(textarea("Visible content description").value).toBe("");
      await edit(textarea("Visible content description"), "A blue jacket beside a closed window");
      await click("Use in chat");
      expect(patched()).toHaveLength(0);
      expect(posted()).toHaveLength(1);
      expect(posted()[0][1].body).toMatchObject({ sourceAssetId: source.id, expectedVisualProfileId: "visual-2", expectedVisualProfileVersion: 4, status: "published" });
    });

    it("opens the current identity's entry even when a previous identity's entry is newer", async () => {
      mockList([{ ...v1(), revision: 9 }, v2()]);
      await render();
      expect(textarea("Visible content description").value).toBe("Described for the current identity");
      await click("Save description");
      expect(posted()).toHaveLength(0);
      expect(patched()[0][1].path.entryId).toBe("entry-v2");
    });

    it("opens the exact historical entry read-only and can still withdraw it", async () => {
      mockList([v1()]);
      await act(async () => root.render(<CharacterChatLibrary characterId="character-1" mediaType="image" canWrite canPublish source={null} onCloseSource={() => undefined} />));
      await waitUntil(() => container.textContent?.includes("Wearing a blue jacket") === true);
      expect(grid().textContent).toContain("From a previous identity");
      await act(async () => grid().click());
      expect(button("Save description").disabled).toBe(true);
      expect(textarea("Visible content description").value).toBe(v1().description);
      await click("Withdraw from chat");
      expect(patched()[0][1]).toMatchObject({ path: { entryId: "entry-v1" }, body: { expectedRevision: 2, status: "withdrawn" } });
      expect(posted()).toHaveLength(0);
    });

    it("keeps the older live identity editable and previews it separately from production", async () => {
      mockList([v1(), v2()], live);
      await act(async () => root.render(<CharacterChatLibrary characterId="character-1" mediaType="image" canWrite canPublish source={null} onCloseSource={() => undefined} />));
      await waitUntil(() => container.textContent?.includes("Wearing a blue jacket") === true);
      expect(grid().textContent).toContain("Live Release identity (v3)");
      expect(container.textContent).toContain("Production identity (v4)");
      expect(container.textContent).toContain("1 published");
      await act(async () => grid().click());
      await edit(textarea("Visible content description"), "Reviewed live asset description");
      await click("Save description");
      expect(patched()[0][1]).toMatchObject({ path: { entryId: "entry-v1" }, body: { description: "Reviewed live asset description" } });
      expect(posted()).toHaveLength(0);

      const query = [...container.querySelectorAll("label")].find(node => node.textContent?.startsWith("Example chat request"))!.querySelector("input")!;
      await edit(query, "Show me the blue jacket");
      await click("Find matching chat media");
      const searchRequests = () => operation.mock.calls.filter(([id]) => id.endsWith("/search-preview"));
      expect(searchRequests()[0][1].body.visualIdentity).toEqual(live.visualIdentity);
      await choose("Visual identity to search", "visual-2");
      await click("Find matching chat media");
      expect(searchRequests()[1][1].body.visualIdentity).toEqual(currentIdentity);
    });
  });

  describe("write failures", () => {
    const failWrites = (cause: unknown) => operation.mockImplementation(async (id) => {
      if (id.startsWith("GET ")) return library([entry()]);
      throw cause;
    });
    const alert = () => container.querySelector('[aria-label="Chat description editor"] [role="alert"]');

    it("does not offer discard-and-reload or claim nothing was written after a 5xx", async () => {
      current = entry(); await render();
      failWrites(new AdminV2RequestError("pg: deadlock detected in media_library", 500, "internal"));
      await click("Save description");
      expect(alert()?.textContent).toContain("Check this record's current state before retrying");
      expect(alert()?.textContent).not.toContain("nothing was written");
      expect(button("Discard edits and reload")).toBeUndefined();
      // The raw authority text stays inside the collapsed technical details.
      expect(alert()?.querySelector("details")?.textContent).toContain("pg: deadlock detected");
      expect(alert()?.querySelector("p")?.textContent).not.toContain("pg: deadlock detected");
    });

    it("does not offer discard-and-reload for a conflict a reload cannot resolve", async () => {
      current = entry(); await render();
      failWrites(new AdminV2RequestError("This source file was replaced; add the replacement as a new library item", 409, "conflict"));
      await click("Use in chat");
      expect(alert()?.textContent).toContain("a precondition was not met");
      expect(button("Discard edits and reload")).toBeUndefined();
    });

    it.each<[string, string, unknown]>([
      ["a stale revision", "This chat library item has changed; reload it before saving", undefined],
      ["a changed visual identity", "The Character visual identity changed; reload before preparing chat media", undefined],
      ["a structured version mismatch", "Revision moved", { blocker: "version_mismatch" }],
    ])("offers discard-and-reload for %s", async (_name, conflict, details) => {
      current = entry(); await render();
      failWrites(new AdminV2RequestError(conflict, 409, "conflict", details));
      await click("Use in chat");
      expect(button("Discard edits and reload")).toBeDefined();
    });

    it.each([false, true])("reloads an unsaved draft onto the available identity after a switch with saved entry=%s", async saved => {
      await render();
      await waitUntil(() => !textarea("Visible content description").disabled);
      await edit(textarea("Visible content description"), "Reviewed doorway portrait");
      const nextIdentity = { visualProfileId: "visual-2", visualProfileVersion: 4 };
      const nextEntry = { ...entry(), id: "entry-v2", visualProfileId: "visual-2", visualProfileVersion: 4 };
      operation.mockImplementation(async id => {
        if (id.startsWith("GET ")) return { ...library(saved ? [nextEntry] : []), visualIdentity: nextIdentity };
        throw new AdminV2RequestError("The Character visual identity changed; reload before preparing chat media", 409, "conflict");
      });
      await click("Save draft");
      await click("Discard edits and reload");
      await waitUntil(() => !!container.querySelector('[aria-label="Chat description editor"]'));
      expect(textarea("Visible content description").disabled).toBe(false);
      expect(container.querySelector('[aria-label="Chat description editor"]')?.textContent).toContain("Production identity (v4)");
      if (saved) expect(textarea("Visible content description").value).toBe(nextEntry.description);
      operation.mockImplementation(async (id, options) => {
        if (id.startsWith("GET ")) return { ...library(), visualIdentity: nextIdentity };
        return { entry: { ...entry(), visualProfileId: "visual-2", visualProfileVersion: 4, ...options.body }, replayed: false };
      });
      await edit(textarea("Visible content description"), "Reviewed current identity portrait");
      await click(saved ? "Save description" : "Save draft");
      const write = operation.mock.calls.findLast(([id]) => id.startsWith(saved ? "PATCH " : "POST "))!;
      if (saved) expect(write[1]).toMatchObject({ path: { entryId: nextEntry.id }, body: { expectedRevision: nextEntry.revision } });
      else expect(write[1].body).toMatchObject({ expectedVisualProfileId: "visual-2", expectedVisualProfileVersion: 4 });
    });

    it("explains a source from another identity instead of asking for a permission", async () => {
      current = entry(); await render();
      failWrites(new AdminV2RequestError("Only platform Character production with this visual identity may enter the shared chat library", 403, "forbidden"));
      await click("Use in chat");
      expect(alert()?.textContent).toContain("produced under a different visual identity");
      expect(alert()?.textContent).not.toContain("does not hold the permission");
      expect(button("Discard edits and reload")).toBeUndefined();
    });

    it("does not treat a conflict with an unverified body as a version conflict", async () => {
      current = entry(); await render();
      failWrites(new AdminV2RequestError("This chat library item has changed; reload it before saving", 409, "conflict", undefined, "request-1", "unknown"));
      await click("Save description");
      expect(button("Discard edits and reload")).toBeUndefined();
    });
  });

  it("shows a failed library read through the operator copy", async () => {
    operation.mockImplementation(async () => { throw new AdminV2RequestError("pg: connection refused", 503, "unavailable"); });
    await act(async () => root.render(<CharacterChatLibrary characterId="character-1" mediaType="image" canWrite canPublish source={null} onCloseSource={() => undefined} />));
    await waitUntil(() => container.querySelector('[role="alert"]') !== null);
    const alert = container.querySelector('[role="alert"]')!;
    expect(alert.textContent).toContain("The authority did not answer.");
    expect(alert.querySelector("span")?.textContent).not.toContain("pg: connection refused");
  });
});
