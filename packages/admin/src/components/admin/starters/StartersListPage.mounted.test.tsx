// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StartersListPage } from "./StartersListPage";

const { apiGet } = vi.hoisted(() => ({ apiGet: vi.fn<(path: string) => Promise<unknown>>() }));
vi.mock("../api", async (original) => ({ ...await original<typeof import("../api")>(), apiGet }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("StartersListPage URL filters", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    vi.useFakeTimers();
    apiGet.mockReset().mockResolvedValue({ items: [], pageInfo: { endCursor: null, hasNextPage: false } });
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); });

  // SPEC: 契约是严格枚举；地址栏里的非法 scope/status 回落 "all"，不能把整页变成一个重试无效的 400。
  it.each([
    ["?scope=everything&status=archived&search=mira", { search: "mira" }],
    ["?scope=community&status=disabled", { scope: "community", status: "disabled" }],
  ])("sends only contract values for %s", async (query, expected) => {
    window.history.replaceState(null, "", `/admin/characters/starters${query}`);
    await act(async () => root.render(<StartersListPage canWrite={false} />));
    for (let tick = 0; tick < 3; tick += 1) await act(async () => { await vi.advanceTimersByTimeAsync(251); });
    const sent = new URL(apiGet.mock.calls.at(-1)![0], window.location.origin).searchParams;
    sent.delete("limit");
    expect(Object.fromEntries(sent)).toEqual(expected);
  });
});
