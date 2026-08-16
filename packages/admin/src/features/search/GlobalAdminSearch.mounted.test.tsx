// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdminPermissionKey } from "@idream/shared/admin/permissions";

const { adminV2Request } = vi.hoisted(() => ({
  adminV2Request: vi.fn<(path: string) => Promise<unknown>>(),
}));

vi.mock("@/lib/admin-v2-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/admin-v2-api")>();
  return { ...actual, adminV2Request };
});

import { AdminI18nProvider } from "@/components/admin/i18n";
import { ALL_SECTION_ITEMS } from "@/components/admin/nav-config";
import { GlobalAdminSearch } from "./GlobalAdminSearch";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const everything = new Set<AdminPermissionKey>(
  ALL_SECTION_ITEMS.flatMap((item) => item.read.allOf),
);

let root: Root | null = null;
let container: HTMLElement | null = null;

async function mountPalette(locale: "en" | "zh" = "zh") {
  container = document.createElement("div");
  document.body.append(container);
  await act(async () => {
    root = createRoot(container!);
    root.render(
      <AdminI18nProvider locale={locale}>
        <GlobalAdminSearch permissions={everything} />
      </AdminI18nProvider>,
    );
  });
}

function input() {
  const element = container?.querySelector<HTMLInputElement>("input[role='combobox']");
  if (!element) throw new Error("palette input is missing");
  return element;
}

// 受控 input 必须走原生 value setter，否则 React 的 value tracker 认为没变，onChange 不触发。
async function type(value: string) {
  const element = input();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function optionLabels() {
  return [...(container?.querySelectorAll("[role='option']") ?? [])]
    .map((option) => option.textContent?.trim() ?? "");
}

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  adminV2Request.mockReset();
  vi.useRealTimers();
});

describe("global admin search as a command palette", () => {
  // SPEC: 导航候选是本地同步算出来的，必须在第一次击键后立刻出现——不等 200ms 防抖，
  //       更不等一次网络往返。
  it("offers a navigation destination without waiting for the record request", async () => {
    adminV2Request.mockImplementation(() => new Promise(() => {}));
    await mountPalette();
    await type("死信");

    expect(adminV2Request).not.toHaveBeenCalled();
    expect(optionLabels().some((label) => label.includes("死信"))).toBe(true);
    expect(container?.textContent).toContain("跳转到");
  });

  // SPEC: 侧栏里根本没有这三个兼容目的地，命令面板是它们唯一的入口。
  it("reaches a destination that navigation never lists", async () => {
    adminV2Request.mockImplementation(() => new Promise(() => {}));
    await mountPalette();
    await type("审核工单");

    const href = container
      ?.querySelector("[role='option'] a")
      ?.getAttribute("href");
    expect(href).toBe("/admin/moderation");
  });

  it("matches the English label while the console is in Chinese", async () => {
    adminV2Request.mockImplementation(() => new Promise(() => {}));
    await mountPalette("zh");
    await type("taxonomy");

    expect(optionLabels().some((label) => label.includes("分类体系"))).toBe(true);
  });

  // SPEC: 上下键在「跳转到」和「搜索结果」之间连续走，不在组边界上卡住。
  it("walks the highlight across both groups with one pair of arrow keys", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    adminV2Request.mockResolvedValue({
      items: [{
        kind: "customer",
        id: "user-1",
        title: "Amy",
        subtitle: "amy@example.test",
        href: "/admin/customers/user-1",
        status: "active",
        updatedAt: "2026-08-16T00:00:00.000Z",
      }],
      query: "taxonomy",
      asOf: "2026-08-16T00:00:00.000Z",
    });
    await mountPalette("en");
    await type("taxonomy");
    await act(async () => { await vi.advanceTimersByTimeAsync(400); });

    const groups = [...(container?.querySelectorAll("[role='group']") ?? [])]
      .map((group) => group.getAttribute("aria-label"));
    expect(groups).toEqual(["Go to", "Search results"]);

    const options = [...(container?.querySelectorAll("[role='option']") ?? [])];
    expect(options.length).toBeGreaterThan(1);
    expect(options[0].getAttribute("aria-selected")).toBe("true");

    // 一路按到底：高亮必须走进第二组，而不是停在第一组的末尾。
    for (let step = 0; step < options.length - 1; step += 1) {
      await act(async () => {
        input().dispatchEvent(new window.KeyboardEvent("keydown", { bubbles: true, key: "ArrowDown" }));
      });
    }
    const selected = [...(container?.querySelectorAll("[role='option']") ?? [])]
      .findIndex((option) => option.getAttribute("aria-selected") === "true");
    expect(selected).toBe(options.length - 1);
    expect(optionLabels()[selected]).toContain("Amy");
  });

  // SPEC: 实体结果晚到时，运营已经选中的那一条不能被挪走。
  // INTENT: 高亮记的是候选的 key 而不是下标——记下标的话，第二组一插进来高亮就漂了。
  it("keeps the operator's highlight where it was when records arrive late", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let resolveRecords: (value: unknown) => void = () => {};
    adminV2Request.mockImplementation(() => new Promise((resolve) => { resolveRecords = resolve; }));
    await mountPalette("en");
    await type("character");
    // 让防抖到点，请求发出去但迟迟不回——此时画面上只有导航候选。
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(adminV2Request).toHaveBeenCalledOnce();

    await act(async () => {
      input().dispatchEvent(new window.KeyboardEvent("keydown", { bubbles: true, key: "ArrowDown" }));
    });
    const chosen = optionLabels()[1];
    expect(chosen).toBeTruthy();

    await act(async () => {
      resolveRecords({
        items: [{
          kind: "character",
          id: "char-1",
          title: "Mara Vale",
          subtitle: "seeded",
          href: "/admin/characters/char-1",
          status: "approved",
          updatedAt: "2026-08-16T00:00:00.000Z",
        }],
        query: "character",
        asOf: "2026-08-16T00:00:00.000Z",
      });
      await vi.advanceTimersByTimeAsync(400);
    });

    expect(optionLabels().some((label) => label.includes("Mara Vale"))).toBe(true);
    const stillSelected = [...(container?.querySelectorAll("[role='option']") ?? [])]
      .find((option) => option.getAttribute("aria-selected") === "true");
    expect(stillSelected?.textContent?.trim()).toBe(chosen);
  });

  // SPEC: 实体请求还在路上时，上一次查询的记录不能跟着新输入一起显示。
  it("drops the previous query's records while the next request is in flight", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    adminV2Request.mockResolvedValue({
      items: [{
        kind: "customer",
        id: "user-1",
        title: "Amy",
        subtitle: "amy@example.test",
        href: "/admin/customers/user-1",
        status: "active",
        updatedAt: "2026-08-16T00:00:00.000Z",
      }],
      query: "amy",
      asOf: "2026-08-16T00:00:00.000Z",
    });
    await mountPalette("en");
    await type("amy");
    await act(async () => { await vi.advanceTimersByTimeAsync(400); });
    expect(optionLabels().some((label) => label.includes("Amy"))).toBe(true);

    adminV2Request.mockImplementation(() => new Promise(() => {}));
    await type("taxonomy");
    expect(optionLabels().some((label) => label.includes("Amy"))).toBe(false);
    expect(optionLabels().some((label) => label.includes("Taxonomy"))).toBe(true);
  });
});
