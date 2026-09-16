// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
const { adminV2Operation } = vi.hoisted(() => ({ adminV2Operation: vi.fn() }));
vi.mock("@/lib/admin-v2-operation", () => ({ adminV2Operation }));
import { ChatEngagementPanel } from "./ChatEngagementPanel";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => { vi.clearAllMocks(); document.body.innerHTML = ""; });
const response = (id: string) => ({
  items: [{ id, userId: "customer", status: "active", sessions: [{ sessionId: "session", characterId: "character", status: "active" }], schedule: null, latestTurn: null }],
  pageInfo: { endCursor: null, hasNextPage: false }, asOf: "2026-09-13T12:00:00.000Z", freshness: "fresh",
});
describe("Chat engagement operations panel", () => {
  it("loads on demand, filters requests, and ignores a stale response after switching views", async () => {
    const host = document.createElement("div"); document.body.append(host);
    const root = createRoot(host);
    let resolveGroups!: (value: unknown) => void;
    adminV2Operation.mockImplementation((_operation: string, options: { query: URLSearchParams }) => options.query.get("kind") === "groups" ? new Promise((resolve) => { resolveGroups = resolve; }) : Promise.resolve(response("proactive-current")));
    await act(async () => { root.render(<ChatEngagementPanel userId="customer" characterId="character" />); });
    expect(adminV2Operation).not.toHaveBeenCalled();
    const buttons = () => [...host.querySelectorAll<HTMLButtonElement>('button[aria-pressed]')];
    await act(async () => { buttons()[0]!.click(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    expect(adminV2Operation).toHaveBeenCalledWith("GET /api/v2/admin/chat/engagement", { query: expect.any(URLSearchParams) });
    const query = adminV2Operation.mock.calls[0]![1].query as URLSearchParams;
    expect(query.get("userId")).toBe("customer");
    expect(query.get("characterId")).toBe("character");
    await act(async () => { buttons()[1]!.click(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    expect(host.textContent).toContain("proactive-current");
    await act(async () => { resolveGroups(response("stale-group")); });
    expect(host.textContent).not.toContain("stale-group");
    expect(host.querySelector('a[href="/admin/customers/customer"]')).not.toBeNull();
    await act(async () => { root.unmount(); });
  });
  it("shows recoverable errors without leaving stale records on screen", async () => {
    const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
    adminV2Operation.mockRejectedValue(new Error("connection unavailable"));
    await act(async () => { root.render(<ChatEngagementPanel userId="" characterId="" />); });
    await act(async () => { host.querySelector<HTMLButtonElement>('button[aria-pressed]')!.click(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    adminV2Operation.mockResolvedValue(response("recovered"));
    await act(async () => { host.querySelector<HTMLButtonElement>('[role="alert"] button')!.click(); });
    expect(host.textContent).toContain("recovered");
    expect(host.querySelector('[role="alert"]')).toBeNull();
    await act(async () => { root.unmount(); });
  });
});
