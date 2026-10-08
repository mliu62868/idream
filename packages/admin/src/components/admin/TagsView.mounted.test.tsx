// @vitest-environment happy-dom

// SPEC: Taxonomy 按 content.read 可读；编辑 / 合并 / 新建只对 content.tag.write 出现，
//       新建标签的确认串是由 label 派生的 slug（与服务端 tagSlug 同规则）。
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ADMIN_WORKSPACE_REFRESH_EVENT } from "@/features/workspace-refresh";
import { TagsView } from "./TagsView";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const tag = {
  id: "tag-1",
  slug: "elf",
  label: "Elf",
  category: null,
  isSensitive: false,
  isMutedByDefault: false,
  characterCount: 2,
};

describe("TagsView write gating", () => {
  let container: HTMLDivElement;
  let root: Root;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "POST") {
        return Response.json({ ok: true, data: { tag: { ...tag, id: "tag-2", slug: "slow-burn", label: "Slow Burn" } } });
      }
      return Response.json({ ok: true, data: { items: [tag] } });
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("hides edit, merge and create controls without content.tag.write", async () => {
    await act(async () => root.render(<TagsView canWrite={false} />));
    await waitFor(() => container.textContent?.includes("Elf") ?? false);

    const labels = Array.from(container.querySelectorAll("button")).map((button) => button.textContent?.trim());
    expect(labels).not.toContain("Edit");
    expect(labels).not.toContain("Merge");
    expect(labels).not.toContain("Create tag");
    expect(container.textContent).toContain("ask an admin owner to grant it");
  });

  it("reloads taxonomy once per shell refresh while preserving filters and an unfinished edit", async () => {
    window.history.replaceState(null, "", "/admin/characters/taxonomy?fixture=retain");
    await act(async () => root.render(<TagsView canWrite />));
    await waitFor(() => container.textContent?.includes("Elf") ?? false);
    const search = container.querySelector<HTMLInputElement>('input[aria-label="Search by slug, label, or category"]')!;
    await changeInput(search, "elf");
    await act(async () => button(container, "Edit")?.click());
    const label = container.querySelector<HTMLInputElement>('tbody input[aria-label="Label"]')!;
    await changeInput(label, "Unfinished taxonomy label");
    fetchMock.mockImplementation(async () => Response.json({ ok: true, data: { items: [{ ...tag, characterCount: 7 }] } }));

    await act(async () => { window.dispatchEvent(new Event(ADMIN_WORKSPACE_REFRESH_EVENT)); });

    expect(fetchMock.mock.calls.filter(([path]) => path === "/api/v2/admin/content/tags")).toHaveLength(2);
    expect(container.querySelector<HTMLInputElement>('tbody input[aria-label="Label"]')?.value).toBe("Unfinished taxonomy label");
    expect(search.value).toBe("elf");
    expect(container.querySelector("tbody")?.textContent).toContain("7");
    expect(window.location.pathname + window.location.search).toBe("/admin/characters/taxonomy?fixture=retain");
    await act(async () => { window.dispatchEvent(new Event(ADMIN_WORKSPACE_REFRESH_EVENT)); });
    expect(fetchMock.mock.calls.filter(([path]) => path === "/api/v2/admin/content/tags")).toHaveLength(3);
  });

  it("creates a tag with the derived slug as confirmation", async () => {
    await act(async () => root.render(<TagsView canWrite />));
    await waitFor(() => container.textContent?.includes("Elf") ?? false);

    const section = Array.from(container.querySelectorAll("section")).find((node) =>
      node.querySelector("h2")?.textContent === "New tag",
    );
    const [labelInput] = Array.from(section?.querySelectorAll("input") ?? []);
    await changeInput(labelInput, "Slow Burn");
    expect(section?.textContent).toContain("slug: slow-burn");

    await act(async () => button(section ?? null, "Create tag")?.click());
    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]');
    const [reasonInput] = Array.from(dialog?.querySelectorAll("input, textarea") ?? []) as HTMLInputElement[];
    await changeInput(reasonInput, "missing mood tag");
    await act(async () => button(dialog, "Create tag")?.click());
    await waitFor(() => postCalls().length === 1);

    expect(JSON.parse(String(postCalls()[0][1]?.body))).toMatchObject({
      label: "Slow Burn",
      category: null,
      reason: "missing mood tag",
      confirmation: "slow-burn",
    });
  });

  it("searches, categorizes and opens editing and merge targets beyond the old limits", async () => {
    const items = Array.from({ length: 501 }, (_, index) => ({
      ...tag,
      id: `tag-${index}`,
      slug: `tag-${String(index).padStart(3, "0")}`,
      label: `Tag ${index}`,
      category: index === 500 ? "last-category" : "common",
    }));
    fetchMock.mockImplementation(async () => Response.json({ ok: true, data: { items } }));
    await act(async () => root.render(<TagsView canWrite />));
    await waitFor(() => container.textContent?.includes("Tag taxonomy — 501") ?? false);

    for (const name of ["Source tag", "Target tag"]) {
      const select = container.querySelector<HTMLSelectElement>(`select[aria-label="${name}"]`)!;
      expect([...select.options].some((option) => option.value === "tag-500")).toBe(true);
    }
    const category = container.querySelector<HTMLSelectElement>('select[aria-label="Category"]')!;
    await act(async () => {
      category.value = "last-category";
      category.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const search = container.querySelector<HTMLInputElement>('input[aria-label="Search by slug, label, or category"]')!;
    await changeInput(search, "Tag 500");
    expect(container.textContent).toContain("Tag taxonomy — 1 of 501");
    expect(container.querySelector("tbody")?.textContent).toContain("Tag 500");
    expect(container.querySelector("tbody")?.textContent).not.toContain("Tag 499");
    await act(async () => button(container, "Edit")?.click());
    expect(container.querySelector<HTMLInputElement>('tbody input[aria-label="Label"]')?.value).toBe("Tag 500");
  });

  function postCalls() {
    return fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "POST") as [
      string,
      RequestInit | undefined,
    ][];
  }
});

function button(scope: HTMLElement | null, label: string) {
  return Array.from(scope?.querySelectorAll("button") ?? []).find(
    (node) => node.textContent?.trim() === label,
  );
}

async function changeInput(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function waitFor(predicate: () => boolean) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (predicate()) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  throw new Error("Condition did not become true");
}
