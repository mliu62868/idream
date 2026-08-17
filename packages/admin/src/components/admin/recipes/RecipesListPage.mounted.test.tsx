// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Recipe } from "./recipes-api";

const { apiGet } = vi.hoisted(() => ({
  apiGet: vi.fn<(path: string) => Promise<unknown>>(),
}));

vi.mock("@/components/admin/api", () => ({ apiGet }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

import { RecipesListPage } from "./RecipesListPage";

function recipe(id: string): Recipe {
  return {
    id,
    recipeKey: id,
    label: id,
    mode: "image",
    useCase: "character",
    body: "",
    negativeBase: null,
    version: 1,
    status: "active",
    createdAt: "2026-08-16T00:00:00.000Z",
    updatedAt: "2026-08-16T00:00:00.000Z",
  };
}

function response(items: readonly Recipe[], pageInfo: Record<string, unknown>) {
  return { items, pageInfo };
}

let container: HTMLDivElement;
let root: Root;

async function mount() {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => { root.render(<RecipesListPage />); });
  await settle();
}

// useUrlBootstrap 走 setTimeout(0)，useDebouncedReload 再排一个 setTimeout(0) 才发请求，
// 响应落地后还要一轮渲染 —— 三次推进覆盖整条链路。
async function settle() {
  for (let tick = 0; tick < 3; tick += 1) {
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  }
}

function findButton(label: string) {
  return [...container.querySelectorAll("button")].find((button) => button.textContent?.includes(label)) ?? null;
}

function cursorsRequested() {
  return apiGet.mock.calls.map(([path]) => new URLSearchParams(path.split("?")[1]).get("cursor"));
}

describe("RecipesListPage cursor history", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    apiGet.mockReset();
    window.history.replaceState(null, "", "/admin/generation/recipes");
  });

  afterEach(async () => {
    await act(async () => { root.unmount(); });
    container.remove();
    vi.useRealTimers();
  });

  // SPEC: 翻页写 pushState —— 本页此前一律 replaceState，运营翻到第 3 页后按浏览器后退
  // 直接离开了列表，连上一页都回不去。
  it("leaves a history entry per page so Back returns to the previous page", async () => {
    apiGet.mockResolvedValue(response([recipe("r1")], { endCursor: "c1", hasNextPage: true }));
    await mount();
    expect(window.location.search).toBe("?limit=25");

    await act(async () => { findButton("Next page")?.click(); });
    await settle();
    expect(window.location.search).toBe("?limit=25&cursor=c1&page=2");
    expect(cursorsRequested()).toEqual([null, "c1"]);

    // 后退：地址栏回到第一页，列表也必须跟着回到第一页的游标。
    await act(async () => { window.history.back(); });
    await settle();
    expect(window.location.search).toBe("?limit=25");
    expect(cursorsRequested()).toEqual([null, "c1", null]);
  });

  // INVARIANT: hasPreviousPage 缺席 = 这个 operation 还是单向 keyset，「上一页」置灰，
  // 绝不当成「你在第一页」而放行一个会 400 的请求。
  it("keeps Previous disabled while the operation is forward-only", async () => {
    apiGet.mockResolvedValue(response([recipe("r1")], {
      endCursor: "c1",
      hasNextPage: true,
      startCursor: "c0",
      hasPreviousPage: true,
    }));
    await mount();

    await act(async () => { findButton("Next page")?.click(); });
    await settle();

    expect(findButton("Previous page")?.disabled).toBe(true);
  });

  // SPEC: 拿不到 totalCount 就不显示「共 N 条」，更不能拿当页条数冒充总数。
  it("never invents a total the authority did not return", async () => {
    apiGet.mockResolvedValue(response([recipe("r1"), recipe("r2")], { endCursor: null, hasNextPage: false }));
    await mount();

    expect(container.textContent).toContain("Showing 2 rows");
    expect(container.textContent).not.toContain("of 2");
  });
});
