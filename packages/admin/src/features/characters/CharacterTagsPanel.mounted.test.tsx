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
