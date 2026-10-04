// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CharacterChatToolsPanel } from "./CharacterChatToolsPanel";
import { CharacterTagsPanel } from "./CharacterTagsPanel";

const api = vi.hoisted(() => ({ apiGet: vi.fn(), apiWrite: vi.fn() }));
vi.mock("@/components/admin/api", () => api);

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// SPEC: tags and the in-chat image switch are reversible settings: neither asks for a reason.
describe("Character overview settings writes", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    api.apiGet.mockReset();
    api.apiWrite.mockReset();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => { act(() => root.unmount()); container.remove(); });

  async function settle() {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
  function button(label: string, scope: ParentNode = container) {
    return [...scope.querySelectorAll("button")].find((item) => item.textContent === label)!;
  }

  it("saves a tag selection in one click", async () => {
    api.apiGet.mockImplementation(async (path: string) => path.startsWith("/api/v2/admin/content/tags")
      ? { items: [{ id: "tag-1", label: "Slow Burn", category: null, isSensitive: false }] }
      : { character: { tags: [] } });
    api.apiWrite.mockResolvedValue({});
    await act(async () => root.render(<CharacterTagsPanel canWrite characterId="character-1" />));
    await settle();
    await act(async () => button("Slow Burn").click());
    await act(async () => button("Save tags").click());
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(api.apiWrite).toHaveBeenCalledWith(
      "/api/v2/admin/content/characters/character-1/tags",
      "PUT",
      { tagIds: ["tag-1"], confirmation: "character-1:tags" },
    );
  });

  it("locks tag edits until the saved selection has been read back", async () => {
    let finishSave!: () => void;
    api.apiGet.mockImplementation(async (path: string) => path.startsWith("/api/v2/admin/content/tags")
      ? { items: [{ id: "tag-1", label: "Slow Burn", category: null, isSensitive: false }] }
      : { character: { tags: [] } });
    api.apiWrite.mockReturnValue(new Promise<void>((resolve) => { finishSave = resolve; }));
    await act(async () => root.render(<CharacterTagsPanel canWrite characterId="character-1" />));
    await settle();
    await act(async () => button("Slow Burn").click());
    await act(async () => button("Save tags").click());
    try {
      expect(button("Slow Burn").disabled).toBe(true);
      expect(button("Slow Burn").getAttribute("aria-pressed")).toBe("true");
    } finally {
      await act(async () => finishSave());
    }
  });

  it("loads the complete vocabulary and saves a tag beyond the old 500 row limit", async () => {
    const items = Array.from({ length: 501 }, (_, index) => ({
      id: `tag-${index}`, label: `Tag ${index}`, category: null, isSensitive: false,
    }));
    api.apiGet.mockImplementation(async (path: string) => {
      if (!path.startsWith("/api/v2/admin/content/tags")) return { character: { tags: [] } };
      const limit = new URL(path, "http://admin.local").searchParams.get("limit");
      return { items: limit ? items.slice(0, Number(limit)) : items };
    });
    api.apiWrite.mockResolvedValue({});
    await act(async () => root.render(<CharacterTagsPanel canWrite characterId="character-1" />));
    await settle();

    expect(button("Tag 500")).toBeDefined();
    await act(async () => button("Tag 500").click());
    await act(async () => button("Save tags").click());
    expect(api.apiWrite).toHaveBeenCalledWith(
      "/api/v2/admin/content/characters/character-1/tags",
      "PUT",
      { tagIds: ["tag-500"], confirmation: "character-1:tags" },
    );
  });

  // SPEC: 服务端 tagIds.max(24)；到上限后未选的标签不可点，并说明原因，而不是保存时吃 400。
  it("caps the selection at 24 tags with a visible hint", async () => {
    const items = Array.from({ length: 26 }, (_, index) => ({ id: `tag-${index}`, label: `Tag ${index}`, category: null, isSensitive: false }));
    api.apiGet.mockImplementation(async (path: string) => path.startsWith("/api/v2/admin/content/tags")
      ? { items }
      : { character: { tags: items.slice(0, 23).map(({ id, label }) => ({ id, label })) } });
    await act(async () => root.render(<CharacterTagsPanel canWrite characterId="character-1" />));
    await settle();
    await act(async () => button("Tag 23").click());
    expect(container.textContent).toContain("24 of 24 tags selected — deselect one to add another.");
    expect(button("Tag 24").disabled).toBe(true);
    expect(button("Tag 0").disabled).toBe(false);
    await act(async () => button("Save tags").click());
    expect(api.apiWrite.mock.calls[0][2].tagIds).toHaveLength(24);
  });

  it("confirms the in-chat image switch without a reason field", async () => {
    api.apiGet.mockResolvedValue({ chatImageToolEnabled: true });
    api.apiWrite.mockResolvedValue({});
    await act(async () => root.render(<CharacterChatToolsPanel canWrite characterId="character-1" />));
    await settle();
    await act(async () => button("Disable image tool").click());
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.querySelector("input, textarea")).toBeNull();
    await act(async () => button("Disable image tool", dialog).click());
    expect(api.apiWrite).toHaveBeenCalledWith(
      "/api/v2/admin/content/characters/character-1/chat-tools",
      "POST",
      { imageToolEnabled: false },
    );
  });
});
