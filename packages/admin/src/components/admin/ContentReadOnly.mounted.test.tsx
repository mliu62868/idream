// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminPermissionKey } from "@idream/shared/admin/permissions";
import { navItems, type AdminSubview, type SectionContext } from "./nav-config";
import { AnnouncementsView } from "./AnnouncementsView";
import { RecipesDetailPage } from "./recipes/RecipesDetailPage";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock("next/link", () => ({ default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => <a href={href} {...props}>{children}</a> }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

const timestamp = "2026-10-01T00:00:00.000Z";
const recipe = {
  id: "recipe-reader", recipeKey: "reader", label: "Readable recipe", mode: "image", useCase: "freeplay",
  body: "Operator recipe description", negativeBase: "blur", version: 1, status: "draft",
  sampleMatrix: [{ prompt: "A calm green room", orientation: "1:1" }], dryRunSummary: null,
  createdAt: timestamp, updatedAt: timestamp,
};
const preset = { id: "preset-reader", scope: "built_in", type: "background", category: "interior", label: "Readable preset", controls: { prompt: "A calm green room" }, visibility: "public", status: "active" };
const announcement = { id: "announcement-reader", version: 1, title: "Operator notice", body: "Full announcement body", level: "info", active: true, serving: true, startsAt: null, endsAt: null, href: "/resources", createdAt: timestamp };
const pageInfo = { hasNextPage: false, endCursor: null };

describe("content read-only operator journeys", () => {
  let root: Root;
  let container: HTMLDivElement;
  let fetchMock: ReturnType<typeof vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>>;

  beforeEach(() => {
    window.history.replaceState(null, "", "/admin");
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    fetchMock = vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>(async input => {
      const path = new URL(String(input), window.location.origin).pathname;
      let data: unknown;
      if (path.endsWith("/announcements")) data = { items: [announcement], pageInfo };
      else if (path.endsWith("/model-profiles")) data = { items: [{ id: "profile-reader", label: "Image profile", mode: "image", status: "active", allowedOrientations: ["1:1"] }] };
      else if (path.endsWith("/preview")) data = { fingerprint: "a".repeat(64), profileId: "profile-reader", issues: [], samples: [{ index: 0, prompt: "Compiled green room", negativePrompt: "blur", orientation: "1:1", issues: [] }], validation: { status: "not_run", issues: [], jobs: [] } };
      else if (path.endsWith(`/recipes/${recipe.id}`)) data = { recipe };
      else if (path.endsWith("/recipes")) data = { items: [recipe], pageInfo };
      else if (path.endsWith(`/presets/${preset.id}`)) data = { preset };
      else if (path.endsWith("/presets")) data = { items: [preset], pageInfo };
      else throw new Error(`Unexpected request ${path}`);
      return Response.json({ ok: true, data });
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    preset.status = "active";
    vi.unstubAllGlobals();
  });

  async function render(node: ReactNode) { await act(async () => root.render(node)); }
  function button(label: string) { return [...container.querySelectorAll("button")].find(node => node.textContent?.trim() === label); }
  function noWrites() { expect(fetchMock.mock.calls.every(([, init]) => !init?.method || init.method === "GET")).toBe(true); }
  function readerView(sectionId: string, permission: AdminPermissionKey, view: AdminSubview = { kind: "list" }) {
    const context: SectionContext = { permissions: new Set([permission]), actorId: "reader", canRead: true, view, workMode: "growth_analyst" };
    return navItems.find(item => item.id === sectionId)!.render(context);
  }

  it("lets a promotion reader inspect the full announcement without offering write actions", async () => {
    await render(readerView("announcements", "growth.promo.read"));
    await waitFor(() => container.textContent?.includes(announcement.title) === true);
    expect(container.querySelector('[title="growth.promo.write"]')).not.toBeNull();
    expect(container.textContent).toContain(announcement.body);
    expect(container.textContent).toContain(announcement.href);
    expect(container.textContent).not.toContain("Create announcement");
    expect(container.querySelector('[aria-label="Edit announcement"]')).toBeNull();
    expect(container.querySelector('[aria-label="Delete announcement"]')).toBeNull();
    expect(button("Deactivate")).toBeUndefined();
    await act(async () => button("Refresh")?.click());
    noWrites();
  });

  it.each([
    ["generation/recipes", "Readable recipe", "/admin/generation/recipes/new"],
    ["generation/presets", "Readable preset", "/admin/generation/presets/new"],
  ])("keeps %s lists browsable without advertising creation to readers", async (sectionId, label, createHref) => {
    await render(readerView(sectionId, "generation.config.read"));
    await waitFor(() => container.textContent?.includes(label) === true);
    expect(container.querySelector(`a[href="${createHref}"]`)).toBeNull();
    expect(container.querySelector('[title="generation.config.write"]')).not.toBeNull();
    noWrites();
  });

  it.each(["generation/recipes", "generation/presets"])("explains the missing capability on a read-only %s new deep link", async sectionId => {
    await render(readerView(sectionId, "generation.config.read", { kind: "new" }));
    expect(container.querySelector('[title="generation.config.write"]')).not.toBeNull();
    expect(container.querySelector("input,textarea,select")).toBeNull();
    expect(container.querySelector("a")).not.toBeNull();
    noWrites();
  });

  it("keeps saved recipe inputs and compiled previews readable without matrix or lifecycle writes", async () => {
    await render(readerView("generation/recipes", "generation.config.read", { kind: "detail", id: recipe.id }));
    await waitFor(() => container.textContent?.includes("Compiled green room") === true);
    expect(container.textContent).toContain(recipe.body);
    expect(container.querySelector('[title="generation.config.write"]')).not.toBeNull();
    expect([...container.querySelectorAll("textarea")].every(input => input.disabled || input.readOnly)).toBe(true);
    for (const label of ["Edit recipe", "Save changes", "Publish", "Rollback", "Add sample scene", "Run sample matrix", "Verify results"]) expect(button(label)).toBeUndefined();
    await act(async () => button("Refresh results")?.click());
    await waitFor(() => fetchMock.mock.calls.filter(([path]) => String(path).includes("/preview?")).length >= 2);
    noWrites();
  });

  it.each(["active", "archived"])("keeps %s presets inspectable without editing, archiving or restoring", async status => {
    preset.status = status;
    await render(readerView("generation/presets", "generation.config.read", { kind: "detail", id: preset.id }));
    await waitFor(() => container.textContent?.includes(preset.label) === true);
    expect(container.textContent).toContain(preset.controls.prompt);
    expect(container.querySelector('[title="generation.config.write"]')).not.toBeNull();
    for (const label of ["Edit profile", "Save changes", "Archive preset", "Restore"]) expect(button(label)).toBeUndefined();
    noWrites();
  });

  it("removes an open announcement editor when write permission is revoked", async () => {
    await render(<AnnouncementsView canWrite />);
    await waitFor(() => container.querySelector('[aria-label="Edit announcement"]') !== null);
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Edit announcement"]')!.click());
    expect(button("Save changes")).toBeDefined();
    await render(<AnnouncementsView canWrite={false} />);
    expect(button("Save changes")).toBeUndefined();
    expect(container.querySelector('input[placeholder="Title"]')).toBeNull();
    noWrites();
  });

  it("returns an open recipe editor to read-only evidence when write permission is revoked", async () => {
    await render(<RecipesDetailPage canWrite id={recipe.id} />);
    await waitFor(() => button("Edit recipe") !== undefined);
    await act(async () => button("Edit recipe")!.click());
    expect(button("Save changes")).toBeDefined();
    await render(<RecipesDetailPage canWrite={false} id={recipe.id} />);
    await waitFor(() => container.textContent?.includes("Compiled green room") === true);
    expect(button("Save changes")).toBeUndefined();
    expect(container.textContent).toContain(recipe.body);
    noWrites();
  });
});

async function waitFor(predicate: () => boolean) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (predicate()) return;
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
  }
  throw new Error("Condition did not become true");
}
