// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CharacterMediaLibraryEntry, CharacterMediaLibraryListResponse } from "@idream/shared/admin";
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
  return { items, nextCursor: null, capabilities: { describe: true, search: true }, visualIdentity: { visualProfileId: "visual-1", visualProfileVersion: 3 } };
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
    expect(container.textContent).toContain("Media is available in chat");
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
      throw new Error("Entry changed. Reload the current revision.");
    });
    await edit(textarea("Visible content description"), "My reviewed description remains here");
    await click("Save description");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Entry changed");
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
    expect(operation.mock.calls.find(([id]) => id.endsWith("/search-preview"))?.[1].body).toEqual({ mediaType: "image", query: "Show me the blue jacket by the window", requiredFacts: ["blue jacket", "window"], excludedFacts: ["hat"], nudity: "unspecified" });
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
});
