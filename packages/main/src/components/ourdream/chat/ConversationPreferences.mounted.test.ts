// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConversationPreferences } from "./ConversationPreferences";
import { CONVERSATION_PROFILE_CATALOG as catalog } from "@/server/modules/chat/conversation-profiles";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;
beforeEach(() => { container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
async function render(sessionId = "session-1") { await act(async () => root.render(createElement(ConversationPreferences, { key: sessionId, sessionId }))); }
function field(label: string) { return container.querySelector<HTMLSelectElement>(`[aria-label="${label}"]`)!; }
async function choose(label: string, value: string) { await act(async () => { field(label).value = value; field(label).dispatchEvent(new Event("change", { bubbles: true })); }); }
async function click(text: string) { await act(async () => [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === text)!.click()); }

describe("Conversation preferences", () => {
  it("saves selected choices with their version and restores them on refresh", async () => {
    let settings = { responseLength: "auto", interactionIntensity: "balanced", version: 0 };
    const requests: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      if (init?.method === "PUT") { const body = JSON.parse(init.body); requests.push(body); settings = { ...body, version: body.version + 1 }; }
      return Response.json({ settings, editable: true, catalog });
    }));
    await render();
    await choose("Reply length", "short");
    await choose("Interaction style", "gentle");
    await choose("Scene direction", "advance");
    await click("Save preferences");
    expect(requests).toEqual([{ responseLength: "short", interactionIntensity: "gentle", sceneGeneration: "advance", version: 0 }]);
    expect(container.textContent).toContain("Saved for new messages");
    await act(async () => root.render(null));
    await render();
    expect(field("Reply length").value).toBe("short");
    expect(field("Interaction style").value).toBe("gentle");
    expect(field("Scene direction").value).toBe("advance");
    expect(container.textContent).toContain("Saved preferences");
  });

  it("retains an unsaved choice after a conflicting save and permits reloading the current version", async () => {
    let reads = 0;
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => init?.method === "PUT"
      ? Response.json({ error: "conflict", message: "Changed elsewhere" }, { status: 409 })
      : Response.json({ settings: { responseLength: ++reads === 1 ? "auto" : "short", interactionIntensity: "balanced", version: reads }, editable: true, catalog })));
    await render();
    expect(field("Scene direction").value).toBe("follow");
    await choose("Reply length", "long");
    await choose("Scene direction", "advance");
    await click("Save preferences");
    expect(field("Reply length").value).toBe("long");
    expect(field("Scene direction").value).toBe("advance");
    expect(container.textContent).toContain("Changed elsewhere");
    await click("Reload preferences");
    expect(field("Reply length").value).toBe("short");
    expect(field("Scene direction").value).toBe("follow");
    expect(container.textContent).not.toContain("Changed elsewhere");
  });

  it("ignores a previous conversation response after switching sessions", async () => {
    let resolveOld!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(async url => String(url).includes("session-1")
      ? new Promise<Response>(resolve => { resolveOld = resolve; })
      : Response.json({ settings: { responseLength: "long", interactionIntensity: "expressive", version: 3 }, editable: false, catalog })));
    await render();
    await render("session-2");
    await act(async () => resolveOld(Response.json({ settings: { responseLength: "short", interactionIntensity: "gentle", version: 1 }, editable: true, catalog })));
    expect(field("Reply length").value).toBe("long");
    expect(field("Reply length").disabled).toBe(true);
    expect(container.textContent).toContain("archived");
  });

  it("shows profile capabilities and cost before saving only the selected identity and version", async () => {
    const writes: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      if (init?.method === "PUT") writes.push(JSON.parse(String(init.body)));
      return Response.json({ settings: { responseLength: "auto", interactionIntensity: "balanced", version: 0 }, editable: true, catalog });
    }));
    await render();
    await choose("Conversation profile", "quick");
    expect(field("Reply length").value).toBe("short");
    expect(container.textContent).toContain("1 message · 0 Dreamcoins");
    expect(container.textContent).toContain("one to three sentences");
    await click("Save preferences");
    expect(writes).toEqual([{ responseLength: "short", interactionIntensity: "balanced", sceneGeneration: "follow", version: 0, conversationProfile: { id: "quick", version: 1 } }]);
    await choose("Conversation profile", "story");
    await choose("Scene direction", "follow");
    expect(field("Conversation profile").value).toBe("custom");
  });
});
