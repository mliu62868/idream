// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { AdminI18nProvider } from "@/components/admin/i18n";
import { MentionsInbox, mentionTargetHref } from "./MentionsInbox";

const { operation } = vi.hoisted(() => ({ operation: vi.fn() }));
vi.mock("@/lib/admin-v2-operation", async (original) => ({ ...await original<typeof import("@/lib/admin-v2-operation")>(), adminV2Operation: operation }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
let container: HTMLDivElement | null = null;
afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  operation.mockReset();
});
async function mount() {
  container = document.createElement("div");
  document.body.append(container);
  await act(async () => { root = createRoot(container!); root.render(<AdminI18nProvider locale="zh"><MentionsInbox /></AdminI18nProvider>); });
}
async function open() {
  await act(async () => {
    const details = container!.querySelector("details")!;
    details.open = true;
  });
}
function button(label: string) {
  return [...container!.querySelectorAll("button")].find((item) => item.textContent === label)!;
}
it("loads only when opened and continues past an empty authorized page to the mentioned record", async () => {
  operation.mockResolvedValueOnce({ items: [], pageInfo: { hasNextPage: true, endCursor: "hidden-page" } });
  await mount();
  expect(operation).not.toHaveBeenCalled();
  await open();
  expect(container!.textContent).toContain("本页暂无提及");
  expect(button("更早的提及")).toBeDefined();
  operation.mockResolvedValueOnce({ items: [{ id: "mention-1", actorId: "operator-1", targetType: "case", targetId: "case/1", body: "请复核这条决定", createdAt: "2026-09-13T01:00:00Z" }], pageInfo: { hasNextPage: false, endCursor: null } });
  await act(async () => button("更早的提及").click());
  expect(operation.mock.lastCall?.[1].query.get("cursor")).toBe("hidden-page");
  expect(container!.textContent).toContain("请复核这条决定");
  expect(container!.querySelector("a")?.getAttribute("href")).toBe("/admin/cases/case%2F1");
  expect(button("更早的提及")).toBeUndefined();
});
it("shows a retryable failure and retries the same page without discarding existing mentions", async () => {
  operation.mockRejectedValueOnce(new Error("offline"));
  await mount(); await open();
  expect(container!.querySelector('[role="alert"]')).not.toBeNull();
  operation.mockResolvedValueOnce({ items: [], pageInfo: { hasNextPage: false, endCursor: null } });
  await act(async () => button("重试").click());
  expect(operation.mock.lastCall?.[1].query.has("cursor")).toBe(false);
  expect(container!.querySelector('[role="alert"]')).toBeNull();
});
it("links every supported collaboration target and restores focus on Escape", async () => {
  expect(mentionTargetHref("incident", "i 1")).toBe("/admin/ops/incidents/i%201");
  expect(mentionTargetHref("creative_run", "r 1")).toBe("/admin/creative/runs/r%201");
  operation.mockResolvedValue({ items: [], pageInfo: { hasNextPage: false, endCursor: null } });
  await mount(); await open();
  await act(async () => container!.querySelector("details")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(container!.querySelector("details")!.open).toBe(false);
  expect(document.activeElement).toBe(container!.querySelector("summary"));
});
