// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { apiGet, adminV2Operation } = vi.hoisted(() => ({ apiGet: vi.fn(), adminV2Operation: vi.fn() }));
vi.mock("@/components/admin/api", () => ({ apiGet, apiWrite: vi.fn() }));
vi.mock("@/lib/admin-v2-operation", () => ({ adminV2Operation }));
vi.mock("@/components/admin/i18n", () => {
  const context = { t: (value: string) => value };
  return { useAdminI18n: () => context, AdminText: ({ text }: { text: string }) => <>{text}</> };
});
vi.mock("@/components/admin/ui/format", () => ({ useAdminFormat: () => ({ dateTime: (value: string) => value }) }));
vi.mock("./CharacterPortfolioCard", () => ({ CharacterPortfolioCard: ({ item }: { item: { characterId: string } }) => <article>{item.characterId}</article> }));

import { CharacterPortfolio } from "./CharacterPortfolio";
import { CharacterChatToolsPanel } from "./CharacterChatToolsPanel";
import { ADMIN_WORKSPACE_REFRESH_EVENT } from "@/features/workspace-refresh";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function waitUntil(predicate: () => boolean) {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for Character refresh");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
}

describe("Character workspace shell refresh", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    apiGet.mockReset();
    adminV2Operation.mockReset();
    window.history.replaceState(null, "", "/admin/characters");
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("refreshes the applied portfolio query and ignores its older response", async () => {
    window.history.replaceState(null, "", "/admin/characters?search=Mira");
    let finishOld!: (value: unknown) => void;
    adminV2Operation.mockReturnValueOnce(new Promise((resolve) => { finishOld = resolve; }))
      .mockResolvedValue({ items: [{ characterId: "fresh-character" }], pageInfo: { endCursor: null, hasNextPage: false }, asOf: "2026-09-02T22:00:00Z" });
    await act(async () => root.render(<CharacterPortfolio canCreate canRead canOpenAssets canOpenProjects mode="studio" />));
    await waitUntil(() => adminV2Operation.mock.calls.length === 1);
    const firstQuery = adminV2Operation.mock.calls[0][1].query;
    expect(new URLSearchParams(firstQuery).get("search")).toBe("Mira");
    await act(async () => { window.dispatchEvent(new Event(ADMIN_WORKSPACE_REFRESH_EVENT)); });
    await waitUntil(() => adminV2Operation.mock.calls.length === 2);
    expect(adminV2Operation.mock.calls[1][1].query).toBe(firstQuery);
    await waitUntil(() => container.textContent?.includes("fresh-character") === true);
    await act(async () => finishOld({ items: [{ characterId: "stale-character" }], pageInfo: { endCursor: null, hasNextPage: false }, asOf: "2026-09-02T21:00:00Z" }));
    expect(container.textContent).toContain("fresh-character");
    expect(container.textContent).not.toContain("stale-character");
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Search characters"]')!.value).toBe("Mira");
  });

  it("does not load a portfolio through shell refresh without read permission", async () => {
    await act(async () => root.render(<CharacterPortfolio canCreate={false} canRead={false} canOpenAssets={false} canOpenProjects={false} mode="studio" />));
    await act(async () => { window.dispatchEvent(new Event(ADMIN_WORKSPACE_REFRESH_EVENT)); });
    expect(adminV2Operation).not.toHaveBeenCalled();
  });

  it("lets an operator retry the first failed chat-tool read", async () => {
    apiGet.mockRejectedValueOnce(new Error("Temporary read failure")).mockResolvedValue({ chatImageToolEnabled: false });
    await act(async () => root.render(<CharacterChatToolsPanel characterId="character-a" canWrite />));
    await waitUntil(() => container.textContent?.includes("Temporary read failure") === true);
    const retry = [...container.querySelectorAll("button")].find((button) => button.textContent === "Retry");
    expect(retry).toBeDefined();
    await act(async () => retry!.click());
    await waitUntil(() => container.textContent?.includes("cannot generate images") === true);
    expect(apiGet).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("keeps the refreshed chat-tool state when an older read arrives late", async () => {
    let finishOld!: (value: unknown) => void;
    apiGet.mockReturnValueOnce(new Promise((resolve) => { finishOld = resolve; }))
      .mockResolvedValue({ chatImageToolEnabled: false });
    await act(async () => root.render(<CharacterChatToolsPanel characterId="character-a" canWrite />));
    await waitUntil(() => apiGet.mock.calls.length === 1);
    await act(async () => { window.dispatchEvent(new Event(ADMIN_WORKSPACE_REFRESH_EVENT)); });
    await waitUntil(() => apiGet.mock.calls.length === 2);
    await waitUntil(() => container.textContent?.includes("cannot generate images") === true);
    await act(async () => finishOld({ chatImageToolEnabled: true }));
    expect(container.textContent).toContain("cannot generate images");
    expect(container.textContent).not.toContain("may generate images");
  });
});
