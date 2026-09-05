// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { UnpreparedCharacters } from "./UnpreparedCharacters";
const { adminV2Request } = vi.hoisted(() => ({ adminV2Request: vi.fn() }));
vi.mock("@/lib/admin-v2-api", async (original) => ({ ...await original<typeof import("@/lib/admin-v2-api")>(), adminV2Request }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const item = { id: "pending-char", name: "Shared Rowan", gender: "female", style: "realistic", status: "pending_review", visibility: "unlisted", creatorId: "customer", createdAt: "2026-09-05T00:00:00.000Z", imageAsset: { id: "portrait", url: "/user-content/portrait/content.png", thumbnailUrl: null }, visualProfile: null, stats: null };
const response = (items: unknown[], cursor: string | null) => ({ items, pageInfo: { endCursor: cursor, hasNextPage: cursor !== null }, asOf: "2026-09-05T00:00:00.000Z", freshness: "fresh" });

describe("historical shared Character discovery", () => {
  let container: HTMLDivElement; let root: Root;
  beforeEach(() => { adminV2Request.mockReset(); container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
  const button = (text: string) => [...container.querySelectorAll("button")].find((node) => node.textContent === text)!;
  it("opens from character management, paginates real pending records, and searches the full list", async () => {
    adminV2Request.mockResolvedValueOnce(response([item], "cursor-1")).mockResolvedValueOnce(response([{ ...item, id: "older-char", name: "Older Rowan" }], null)).mockResolvedValueOnce(response([], null));
    await act(async () => root.render(<UnpreparedCharacters />));
    expect(adminV2Request).not.toHaveBeenCalled();
    await act(async () => button("Shared characters awaiting preparation").click());
    expect(container.querySelector("a")?.getAttribute("href")).toBe("/admin/characters/pending-char");
    expect(container.querySelector("img")?.getAttribute("src")).toBe(item.imageAsset.url);
    expect(container.textContent).not.toContain("Approve"); expect(container.textContent).not.toContain("Reject");
    await act(async () => button("Load more characters").click());
    expect(adminV2Request.mock.calls[1][0]).toContain("cursor=cursor-1");
    expect(container.textContent).toContain("Older Rowan"); expect(container.querySelectorAll("li")).toHaveLength(2);
    const search = container.querySelector("input")!;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, "Missing"); search.dispatchEvent(new Event("input", { bubbles: true })); });
    await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(adminV2Request.mock.calls[2][0]).toContain("search=Missing"); expect(adminV2Request.mock.calls[2][0]).not.toContain("cursor=");
    expect(container.textContent).toContain("No characters are awaiting preparation.");
  });
});
