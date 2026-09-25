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

describe("GroupChatManager add members", () => {
  it("adds picked Characters to a saved group, keeping current members unselectable", async () => {
    const members = [{ characterId: "a", sessionId: "sa", name: "Ava" }, { characterId: "b", sessionId: "sb", name: "Bea" }];
    const patches: { body: unknown; scope: string | null }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const path = String(url);
      if (path === "/api/v1/me") return envelope({ user: { id: "owner", email: "owner@example.test", displayName: "owner", image: null }, ageGate: { accepted: true } });
      if (path.startsWith("/api/v1/chat/groups/candidates")) return Response.json({ items: [
        { id: "a", name: "Ava", description: "", owned: true }, { id: "c", name: "Cleo", description: "", owned: false },
      ], nextCursor: null });
      if (path === "/api/v1/chat/groups/group-1" && init?.method === "PATCH") {
        patches.push({ body: JSON.parse(String(init.body)), scope: new Headers(init.headers).get("x-idream-viewer-scope") });
        members.push({ characterId: "c", sessionId: "sc", name: "Cleo" });
        return Response.json({ id: "group-1", title: "Trio", status: "active", members });
      }
      return Response.json({ ownerScope: "user:owner", groups: [{ id: "group-1", title: "Trio", status: "active", members: [...members] }] });
    }));
    await act(async () => root.render(createElement(GroupChatManager)));
    await until(() => Boolean(button("Add character")));
    await act(async () => button("Add character").click());
    expect(container.textContent).toContain("can read everything said in this group before they arrived");
    expect(container.textContent).toContain("2 of 12 members");
    const option = (name: string) => [...container.querySelectorAll("label")].find(label => label.textContent?.startsWith(name))!.querySelector("input")!;
    expect(option("Ava").disabled).toBe(true);
    expect(option("Ava").closest("label")!.textContent).toContain("Already in this group");
    expect(button("Add to group").disabled).toBe(true);
    await act(async () => option("Cleo").click());
    expect(container.textContent).toContain("3 of 12 members");
    await act(async () => button("Add to group").click());
    await until(() => container.textContent?.includes("Added Cleo to Trio.") ?? false);
    expect(patches).toEqual([{ body: { addCharacterIds: ["c"] }, scope: "user:owner" }]);
    expect(container.textContent).toContain("Ava · Bea · Cleo");
    expect(button("Create group chat")).toBeTruthy();
  });

  it("keeps the new-group picks when the owner opens and cancels Add character", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL) => {
      const path = String(url);
      if (path === "/api/v1/me") return envelope({ user: { id: "owner", email: "owner@example.test", displayName: "owner", image: null }, ageGate: { accepted: true } });
      if (path.startsWith("/api/v1/chat/groups/candidates")) return Response.json({ items: [
        { id: "a", name: "Ava", description: "", owned: true }, { id: "c", name: "Cleo", description: "", owned: false },
      ], nextCursor: null });
      return Response.json({ ownerScope: "user:owner", groups: [{ id: "group-1", title: "Trio", status: "active", members: [{ characterId: "b", sessionId: "sb", name: "Bea" }] }] });
    }));
    await act(async () => root.render(createElement(GroupChatManager)));
    await until(() => Boolean(button("Add character")));
    const option = (name: string) => [...container.querySelectorAll("label")].find(label => label.textContent?.startsWith(name))!.querySelector("input")!;
    await until(() => Boolean([...container.querySelectorAll("label")].find(label => label.textContent?.startsWith("Cleo"))));
    await act(async () => option("Cleo").click());
    await act(async () => button("Add character").click());
    expect(option("Cleo").checked).toBe(false);
    await act(async () => button("Cancel").click());
    expect(option("Cleo").checked).toBe(true);
  });
});
