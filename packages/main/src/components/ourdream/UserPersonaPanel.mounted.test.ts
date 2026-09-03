// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UserPersonaPanel } from "./UserPersonaPanel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;
beforeEach(() => { container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
async function render(viewer = "one", key = viewer) { await act(async () => root.render(createElement(UserPersonaPanel, { key, ownerScope: `user:${viewer}` }))); }
function field(label: string) { return container.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`)!; }
async function enter(label: string, value: string) {
  await act(async () => {
    const input = field(label);
    Object.getOwnPropertyDescriptor(input.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function click(text: string) { await act(async () => [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === text)!.click()); }
const success = (data: Record<string, unknown>, ownerScope = "user:one") => Response.json({ ok: true, data: { ownerScope, ...data } });

describe("global persona settings", () => {
  it("saves exact in-progress text, restores it, disables it and clears with the last accepted version", async () => {
    let settings: { persona: { enabled: boolean; name: string; description: string; version: number } | null; version: number } = { persona: null, version: 0 };
    const requests: Array<{ method: string; body: unknown }> = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init?: RequestInit) => {
      if (init?.method) {
        const body = JSON.parse(String(init.body));
        requests.push({ method: init.method, body });
        settings = { persona: init.method === "DELETE" ? null : { name: body.name, description: body.description, enabled: body.enabled, version: body.version + 1 }, version: body.version + 1 };
      }
      return success(settings);
    }));
    await render();
    await enter("Persona name", "Robin");
    await enter("About your persona", "A botanist ");
    expect(field("About your persona").value).toBe("A botanist ");
    await enter("About your persona", "A botanist with a blue notebook.");
    await click("Save persona");
    expect(requests[0]).toEqual({ method: "PUT", body: { enabled: true, name: "Robin", description: "A botanist with a blue notebook.", ownerScope: "user:one", version: 0 } });
    await act(async () => root.render(null));
    await render();
    expect(field("Persona name").value).toBe("Robin");
    expect(field("About your persona").value).toBe("A botanist with a blue notebook.");
    await act(async () => (field("Use my persona in chats") as HTMLInputElement).click());
    await click("Save persona");
    expect(requests[1]).toMatchObject({ method: "PUT", body: { enabled: false, version: 1 } });
    expect(container.textContent).toContain("New messages will not use your persona");
    await click("Clear persona");
    expect(requests[2]).toEqual({ method: "DELETE", body: { ownerScope: "user:one", version: 2 } });
    expect(field("Persona name").value).toBe("");
    expect(container.textContent).not.toContain("Clear persona");
  });

  it("retains a conflicting draft until the user reloads the current account version", async () => {
    let reads = 0;
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init?: RequestInit) => init?.method === "PUT"
      ? Response.json({ error: { message: "Your chat persona changed elsewhere. Reload before saving" } }, { status: 409 })
      : success({ persona: { name: ++reads === 1 ? "Robin" : "Juniper", description: "Botanist", enabled: true, version: reads }, version: reads })));
    await render();
    await enter("Persona name", "My unfinished name");
    await click("Save persona");
    expect(field("Persona name").value).toBe("My unfinished name");
    expect(container.textContent).toContain("changed elsewhere");
    await click("Reload persona");
    expect(field("Persona name").value).toBe("Juniper");
    expect(container.textContent).not.toContain("changed elsewhere");
  });

  it("ignores a previous account's late save when the confirmed owner changes without a parent remount", async () => {
    let resolveSave!: (response: Response) => void;
    let resolveNextRead!: (response: Response) => void;
    let reads = 0;
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init?: RequestInit) => init?.method === "PUT"
      ? new Promise<Response>(resolve => { resolveSave = resolve; })
      : ++reads === 1
        ? success({ persona: { name: "Robin", description: "Reader", enabled: true, version: 1 }, version: 1 })
        : new Promise<Response>(resolve => { resolveNextRead = resolve; })));
    await render();
    await enter("Persona name", "Old account draft");
    await click("Save persona");
    await render("two", "one");
    expect(field("Persona name").value).toBe("");
    expect(field("Persona name").disabled).toBe(true);
    await act(async () => resolveSave(success({ persona: { name: "Old account draft", description: "Reader", enabled: true, version: 2 }, version: 2 })));
    expect(field("Persona name").value).toBe("");
    expect(container.textContent).not.toContain("Persona saved for new messages");
    await act(async () => resolveNextRead(success({ persona: { name: "Cedar", description: "Reader", enabled: true, version: 1 }, version: 1 }, "user:two")));
    expect(field("Persona name").value).toBe("Cedar");
    expect(container.textContent).not.toContain("Persona saved for new messages");
  });

  it("rejects a first persona read for a different account than the profile page", async () => {
    const fetcher = vi.fn(async () => success({ persona: { name: "Other account", description: "Private description", enabled: true, version: 1 }, version: 1 }, "user:two"));
    vi.stubGlobal("fetch", fetcher);
    await render("one");
    expect(field("Persona name").value).toBe("");
    expect(field("About your persona").value).toBe("");
    expect(field("Persona name").disabled).toBe(true);
    expect(container.textContent).toContain("Reload this page");
    expect(container.textContent).not.toContain("Other account");
    await click("Save persona");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("keeps the loaded owner in writes and hides the old draft when the current account rejects it", async () => {
    let currentOwner = "user:one";
    const writes: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init?: RequestInit) => {
      if (!init?.method) return success({ persona: null, version: 0 }, currentOwner);
      const body = JSON.parse(String(init.body));
      writes.push(body);
      return body.ownerScope !== currentOwner
        ? Response.json({ error: { message: "The signed-in account changed. Reload this page before editing your persona" } }, { status: 403 })
        : success({ persona: { name: body.name, description: body.description, enabled: body.enabled, version: 1 }, version: 1 }, currentOwner);
    }));
    await render();
    await enter("Persona name", "Old account draft");
    currentOwner = "user:two"; // Cookies changed in another tab; the parent never remounted.
    await click("Save persona");
    expect(writes).toEqual([{ ownerScope: "user:one", name: "Old account draft", description: "", enabled: true, version: 0 }]);
    expect(field("Persona name").value).toBe("");
    expect(field("Persona name").disabled).toBe(true);
    expect(container.textContent).toContain("Reload this page");
    expect(container.textContent).not.toContain("Persona saved for new messages");
  });
});
