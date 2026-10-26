// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CharacterImageLibrary } from "./CharacterImageLibrary";
import { CharacterVideoLibrary } from "./CharacterVideoLibrary";
import { characterWorkspaceDetail } from "./character-workspace-fixture";

const { read, archive } = vi.hoisted(() => ({ read: vi.fn(), archive: vi.fn() }));
vi.mock("@/lib/admin-v2-operation", () => ({ adminV2Operation: (...args: unknown[]) => read(...args) }));
vi.mock("@/components/admin/api", () => ({ apiGet: (...args: unknown[]) => read(...args) }));
vi.mock("@/components/admin/assets/assets-api", async importOriginal => ({
  ...await importOriginal<typeof import("@/components/admin/assets/assets-api")>(),
  bulkArchiveAssets: (...args: unknown[]) => archive(...args),
}));
vi.mock("next/image", () => ({ default: () => <span /> }));
vi.mock("./CharacterAssetStudio", () => ({ CharacterAssetStudio: () => <span /> }));
vi.mock("./CharacterVideoStudio", () => ({ CharacterVideoStudio: () => <span /> }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe.each(["image", "video"] as const)("Character %s archive permission", modality => {
  let root: Root;
  let container: HTMLDivElement;
  const data = characterWorkspaceDetail();
  beforeEach(() => {
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    read.mockReset(); archive.mockReset();
    read.mockResolvedValue({ items: [{
      id: "library-asset", filename: "Library asset", type: modality, url: "/uploads/asset.png", thumbnailUrl: null,
      platformStatus: "approved", placements: [], authorityDependencies: [], tags: [], createdAt: "2026-10-25T00:00:00Z",
    }] });
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
  async function render(canArchive: boolean) {
    await act(async () => root.render(modality === "image"
      ? <CharacterImageLibrary actorId="operator-1" data={data} canRead canReadProduction={false} canCreate={false}
          canReview={false} canArchive={canArchive} onContinue={() => undefined} onProjectReload={async () => undefined}
          commitProjectMutation={async ({ commit }) => ({ result: await commit(), refreshed: true })} />
      : <CharacterVideoLibrary actorId="operator-1" data={data} canRead canReadProduction={false} canImport={false}
          canCreate={false} canArchive={canArchive} onCreateImage={() => undefined} onProjectReload={async () => undefined}
          runCommittedMutation={async ({ commit }) => ({ result: await commit(), refreshed: true })} />));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  }
  async function open() {
    const button = container.querySelector<HTMLButtonElement>(`[aria-label="Remove ${modality} from library"]`)!;
    await act(async () => button.click());
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  }
  it("discards the old confirmation across revoke and regrant", async () => {
    await render(true); await open();
    await render(false);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await render(true);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await open();
    expect(document.querySelector<HTMLInputElement>('[role="dialog"] input')!.value).toBe("");
    expect(archive).not.toHaveBeenCalled();
  });
  it("ignores an old archive completion after permission changed", async () => {
    let complete!: () => void;
    archive.mockImplementation(() => new Promise<void>(resolve => { complete = resolve; }));
    await render(true); await open();
    const dialog = document.querySelector('[role="dialog"]')!;
    const inputs = dialog.querySelectorAll<HTMLInputElement>("input");
    for (const [index, input] of [...inputs].entries()) {
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, index === 0 ? "Retire old fixture" : "library-");
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    }
    const submit = [...dialog.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Remove from library")!;
    await act(async () => submit.click());
    expect(archive).toHaveBeenCalledTimes(1);
    await render(false); await render(true);
    await open();
    const reads = read.mock.calls.length;
    await act(async () => complete());
    expect(container.textContent).not.toContain(`${modality === "image" ? "Image" : "Video"} removed from the library`);
    expect(read).toHaveBeenCalledTimes(reads);
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  });
});
