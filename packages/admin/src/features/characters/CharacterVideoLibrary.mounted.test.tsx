// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CharacterVideoLibrary } from "./CharacterVideoLibrary";
import { characterWorkspaceDetail } from "./character-workspace-fixture";
const { read } = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("@/components/admin/api", () => ({ apiGet: (...args: unknown[]) => read(...args) }));
vi.mock("./CharacterVideoStudio", () => ({ CharacterVideoStudio: () => <span /> }));
vi.mock("./CharacterChatLibrary", () => ({ CharacterChatLibrary: () => <span /> }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function asset(id: string) { return { id, url: `/user-content/${id}.webm`, platformStatus: "generated", tags: [], sourceJob: null }; }
async function waitUntil(predicate: () => boolean) {
  const deadline = Date.now() + 2_000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error("Timed out waiting for video library"); await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); }
}
describe("Character video library pagination", () => {
  let root: Root; let container: HTMLDivElement;
  beforeEach(() => { container = document.createElement("div"); document.body.append(container); root = createRoot(container); read.mockReset(); });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
  it("loads older pages and searches the full server library", async () => {
    read.mockImplementation(async (path: string) => {
      const params = new URL(path, "http://admin.test").searchParams;
      if (params.has("search")) return { items: [asset("older-match")], nextCursor: null };
      if (params.has("cursor")) return { items: [asset("page-two")], nextCursor: null };
      return { items: [asset("page-one")], nextCursor: "video-cursor-1" };
    });
    await act(async () => root.render(<CharacterVideoLibrary actorId="operator-1" data={characterWorkspaceDetail()} canRead canReadProduction={false} canImport={false} canCreate={false} canArchive={false} onCreateImage={() => undefined} onProjectReload={async () => undefined} runCommittedMutation={async ({ commit }) => ({ result: await commit(), refreshed: true })} />));
    await waitUntil(() => container.textContent?.includes("page-one") ?? false);
    expect(new URL(read.mock.calls[0][0], "http://admin.test").searchParams.get("limit")).toBe("25");
    const more = [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Load more videos")!;
    await act(async () => more.click());
    expect(container.textContent).toContain("page-one"); expect(container.textContent).toContain("page-two");
    expect(read.mock.calls.some(([path]) => new URL(path, "http://admin.test").searchParams.get("cursor") === "video-cursor-1")).toBe(true);
    const search = container.querySelector<HTMLInputElement>('input[placeholder="Search videos"]')!;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, "older"); search.dispatchEvent(new Event("input", { bubbles: true })); });
    await waitUntil(() => container.textContent?.includes("older-match") ?? false);
    expect(container.textContent).not.toContain("page-one");
    expect(container.textContent).not.toContain("page-two");
    const params = new URL(read.mock.calls.at(-1)![0], "http://admin.test").searchParams;
    expect(params.get("search")).toBe("older"); expect(params.has("cursor")).toBe(false);
  });
});
