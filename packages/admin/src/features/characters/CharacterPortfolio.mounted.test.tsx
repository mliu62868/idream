// @vitest-environment happy-dom

import type { AdminPermissionKey } from "@idream/shared/admin";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { adminV2Operation } = vi.hoisted(() => ({ adminV2Operation: vi.fn() }));
vi.mock("@/lib/admin-v2-operation", () => ({
  adminV2Operation,
  adminV2OperationAllowed: () => true,
}));
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(window.location.search) }));

import { AdminI18nProvider } from "@/components/admin/i18n";
import { characterWorkspaceDetail } from "./character-workspace-fixture";
import { CharacterPortfolio } from "./CharacterPortfolio";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const baseItem = characterWorkspaceDetail().portfolio;
const item = (id: string, name: string, state: string) => ({
  ...baseItem,
  characterId: id,
  name,
  serving: { ...baseItem.serving, characterId: id, state, version: 4 },
});
const counts = {
  all: 3, draft: 1, live: 2, paused: 0, archived: 5, retired: 6, attention: 1, live_asset_pack_incomplete: 0,
  pending_changes: 2, candidate_unpublished: 0, publish_blocked: 0, recent_generation_failed: 4, ready_to_publish: 0,
};

describe("Character list work queues and bulk actions", () => {
  let container: HTMLDivElement;
  let root: Root;
  let pages: Record<string, unknown[]>;
  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    adminV2Operation.mockReset();
    window.history.replaceState(null, "", "/admin/characters");
    pages = {
      default: [item("a", "Mira", "live"), item("b", "Nova", "paused")],
      queue: [item("c", "Rae", "live")],
    };
    adminV2Operation.mockImplementation(async (id: string, options: { query?: string; path?: { id?: string } }) => {
      if (id === "GET /api/v2/admin/characters/portfolio") {
        const query = new URLSearchParams(options.query);
        return {
          items: query.get("workQueue") ? pages.queue : pages.default,
          pageInfo: { endCursor: null, hasNextPage: false },
          facets: { viewCounts: counts },
          asOf: "2026-09-02T22:00:00.000Z",
          freshness: "fresh",
        };
      }
      if (id === "GET /api/v2/admin/content/tags") return { items: [] };
      if (id === "POST /api/v2/admin/characters/:id/commands/pause") {
        if (options.path?.id === "c") throw new Error("Version conflict");
        return { status: "accepted", commandId: "command-1" };
      }
      if (id === "GET /api/v2/admin/commands/:commandId") return { status: "succeeded" };
      throw new Error(`Unexpected ${id}`);
    });
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  const settle = async (predicate: () => boolean) => {
    const deadline = Date.now() + 4_000;
    while (!predicate()) {
      if (Date.now() >= deadline) throw new Error(`Timed out: ${container.textContent}`);
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
    }
  };
  const button = (label: string, within: ParentNode = document) =>
    [...within.querySelectorAll("button")].find((node) => node.textContent?.trim().startsWith(label));
  const render = async (extraPermissions: AdminPermissionKey[] = []) => {
    await act(async () => root.render(
      <AdminI18nProvider locale="en">
        <CharacterPortfolio
          actorId="actor-1"
          canCreate={false}
          canOpenAssets
          canOpenProjects
          canRead
          mode="studio"
          permissions={new Set<AdminPermissionKey>(["character.release.publish", ...extraPermissions])}
        />
      </AdminI18nProvider>,
    ));
    await settle(() => container.textContent?.includes("Mira") === true);
  };

  it("shows exact view counts, excludes archived from All and queries a queue before paging", async () => {
    await render();
    const firstQuery = new URLSearchParams(adminV2Operation.mock.calls[0][1].query);
    expect(firstQuery.get("excludeArchived")).toBe("true");
    expect(firstQuery.get("includeFacets")).toBe("true");
    expect(button("Archived drafts")?.textContent).toContain("5");
    expect(button("Retired")?.textContent).toContain("6");
    expect(button("Generation failed")?.textContent).toContain("4");
    await act(async () => button("Generation failed")?.click());
    await settle(() => container.textContent?.includes("Rae") === true);
    const portfolioCalls = adminV2Operation.mock.calls.filter(([id]) => id === "GET /api/v2/admin/characters/portfolio");
    expect(new URLSearchParams(portfolioCalls.at(-1)?.[1].query).get("workQueue")).toBe("recent_generation_failed");
    expect(window.location.search).toContain("workQueue=recent_generation_failed");
    await act(async () => button("Archived drafts")?.click());
    const portfolioQuery = () => new URLSearchParams(adminV2Operation.mock.calls.filter(([id]) => id === "GET /api/v2/admin/characters/portfolio").at(-1)?.[1].query);
    expect(portfolioQuery().get("lifecycle")).toBe("archived");
    expect(portfolioQuery().has("servingState")).toBe(false);
    expect(portfolioQuery().has("excludeArchived")).toBe(false);
    // 已退役是单独的视图：不可恢复，与归档草稿分开。
    await act(async () => button("Retired")?.click());
    expect(portfolioQuery().get("lifecycle")).toBe("retired");
    expect(portfolioQuery().has("excludeArchived")).toBe(false);
  });

  it("keeps the filtered roster, tab, and anchor on table navigation", async () => {
    pages.queue = [{
      ...item("c", "Rae", "live"),
      journey: {
        ...baseItem.journey,
        primaryAction: { ...baseItem.journey.primaryAction, deepLink: "/admin/characters/c?tab=visual#visual-reference-set" },
      },
    }];
    await render();
    await act(async () => button("Generation failed")?.click());
    await settle(() => container.textContent?.includes("Rae") === true);
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Table view"]')?.click());
    const links = [...container.querySelectorAll<HTMLAnchorElement>("tbody a")].map((link) => new URL(link.href));
    expect(links).toHaveLength(3);
    expect(links.every((link) => link.searchParams.get("roster") === "workQueue=recent_generation_failed")).toBe(true);
    expect(links.find((link) => link.hash === "#visual-reference-set")?.searchParams.get("tab")).toBe("visual");
  });

  it("follows an accepted row command past six polls and shows a late failure", async () => {
    await render(["dashboard.read", "character.release.read"]);
    const original = adminV2Operation.getMockImplementation()!;
    let reads = 0;
    adminV2Operation.mockImplementation((id, options) =>
      id === "GET /api/v2/admin/commands/:commandId"
        ? Promise.resolve({ status: ++reads > 6 ? "failed" : "running" })
        : original(id, options),
    );
    vi.useFakeTimers();
    try {
      await act(async () => button("Pause", container.querySelector("article")!)?.click());
      expect(container.textContent).toContain("Mira · Accepted");
      for (let i = 0; i < 8; i += 1) {
        await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
      }
      expect(reads).toBe(7);
      expect(container.querySelector('[role="alert"]')?.textContent).toContain("Mira · Command failed.");
      expect(container.textContent).not.toContain("Mira · Accepted");
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses the portfolio to confirm serving when command details are outside the operator's grants", async () => {
    await render();
    await act(async () => button("Pause", container.querySelector("article")!)?.click());
    pages.default = [item("a", "Mira", "paused")];
    await settle(() => button("Resume", container.querySelector("article")!) !== undefined);
    expect(container.textContent).not.toContain("Mira · Accepted");
    expect(adminV2Operation.mock.calls.some(([id]) => id === "GET /api/v2/admin/commands/:commandId")).toBe(false);
    expect(adminV2Operation.mock.calls.some(([id, options]) =>
      id === "GET /api/v2/admin/characters/portfolio" && new URLSearchParams(options.query).get("search") === "a",
    )).toBe(true);
  });

  // SPEC: 选中绑定角色 ID；确认框只显示数量和名字；不适用的跳过并说明；失败项可重试。
  it("keeps the selection across views, runs each item independently and retries failures", async () => {
    await render();
    const check = (name: string) =>
      container.querySelector<HTMLInputElement>(`input[aria-label="Select ${name}"]`);
    await act(async () => check("Mira")?.click());
    await act(async () => check("Nova")?.click());
    expect(container.textContent).toContain("2 selected");

    await act(async () => button("Generation failed")?.click());
    await settle(() => check("Rae") !== null);
    expect(container.textContent).toContain("2 selected");
    await act(async () => check("Rae")?.click());
    expect(container.textContent).toContain("3 selected");

    const bar = container.querySelector('section[aria-label="Bulk actions"]')!;
    await act(async () => button("Pause", bar)?.click());
    const dialog = document.querySelector('[role="dialog"], [role="alertdialog"]')!;
    expect(dialog.textContent).toContain("Pause: 2 characters");
    expect(dialog.textContent).toContain("Mira, Rae");
    expect(dialog.textContent).toContain("Skipped Nova: Only live characters can be paused.");
    expect(dialog.querySelector("input, textarea")).toBeNull();
    await act(async () => [...dialog.querySelectorAll("button")].find((node) => node.textContent?.trim() === "Pause")?.click());

    await settle(() => container.textContent?.includes("Version conflict") === true && container.textContent?.includes("Done") === true);
    expect(adminV2Operation.mock.calls.filter(([id]) => id === "POST /api/v2/admin/characters/:id/commands/pause")).toHaveLength(2);
    expect(button("Retry 1 failed")).toBeDefined();
  }, 15_000);
});
