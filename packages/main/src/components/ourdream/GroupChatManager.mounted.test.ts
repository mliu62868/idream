// @vitest-environment happy-dom
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({ default: ({ href, children, ...props }: ComponentProps<"a">) => createElement("a", { ...props, href: String(href) }, children) }));
vi.mock("./AgeGateBoundary", () => ({ useAgeGateAccess: () => ({ accepted: true }) }));
vi.mock("./AppSidebar", () => ({ AppSidebar: () => null }));
vi.mock("./MobileBottomNav", () => ({ MobileBottomNav: () => null }));
import { GroupChatManager } from "./GroupChatManager";
import { invalidateViewerAuthority } from "./viewer-auth";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;
beforeEach(() => { invalidateViewerAuthority(); container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

function envelope(data: unknown) { return Response.json({ ok: true, data }); }
async function until(condition: () => boolean) {
  for (let index = 0; index < 30; index += 1) {
    if (condition()) return;
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
  expect(condition(), container.textContent ?? "").toBe(true);
}
function button(label: string) { return [...container.querySelectorAll("button")].find((item) => item.textContent === label)!; }

describe("GroupChatManager rename", () => {
  it("renames a saved group through PATCH title", async () => {
    let title = "Old name";
    const patches: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const path = String(url);
      if (path === "/api/v1/me") return envelope({ user: { id: "owner", email: "owner@example.test", displayName: "owner", image: null }, ageGate: { accepted: true } });
      // The chat BFF answers with bare JSON, not the v1 envelope.
      if (path.startsWith("/api/v1/chat/groups/candidates")) return Response.json({ items: [], nextCursor: null });
      if (path === "/api/v1/chat/groups/group-1" && init?.method === "PATCH") {
        patches.push(JSON.parse(String(init.body)));
        title = "New name";
        return Response.json({ id: "group-1", title, status: "active" });
      }
      return Response.json({ ownerScope: "user:owner", groups: [{ id: "group-1", title, status: "active", members: [
        { characterId: "a", sessionId: "sa", name: "Ava" }, { characterId: "b", sessionId: "sb", name: "Bea" },
      ] }] });
    }));
    await act(async () => root.render(createElement(GroupChatManager)));
    await until(() => Boolean(button("Rename")));
    await act(async () => button("Rename").click());
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Group name"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "New name");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => button("Save name").click());
    await until(() => container.textContent?.includes("New name") ?? false);
    expect(patches).toEqual([{ title: "New name" }]);
    expect(container.querySelector('input[aria-label="Group name"]')).toBeNull();
  });
});
