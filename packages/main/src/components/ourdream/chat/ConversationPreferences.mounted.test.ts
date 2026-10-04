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
  it("saves each choice as it is made, with its version, and restores them on refresh", async () => {
    let settings = { responseLength: "auto", interactionIntensity: "balanced", version: 0 };
    const requests: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      if (init?.method === "PUT") { const body = JSON.parse(init.body); requests.push(body); settings = { ...body, version: body.version + 1 }; }
      return Response.json({ settings, editable: true, catalog });
    }));
    await render();
    // No separate Save step: a choice the reader sees is a choice that applies.
    expect([...container.querySelectorAll("button")].map(button => button.textContent)).not.toContain("Save preferences");
    await choose("Reply length", "short");
    expect(requests).toEqual([{ responseLength: "short", interactionIntensity: "balanced", sceneGeneration: "follow", version: 0 }]);
    expect(container.textContent).toContain("Saved for new messages");
    await choose("Interaction style", "gentle");
    await choose("Scene direction", "advance");
    expect(requests.at(-1)).toEqual({ responseLength: "short", interactionIntensity: "gentle", sceneGeneration: "advance", version: 2 });
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
    expect(field("Reply length").value).toBe("long");
    expect(field("Scene direction").value).toBe("advance");
    expect(container.textContent).toContain("Changed elsewhere");
    expect(container.textContent).toContain("Not saved yet");
    expect(container.textContent).not.toContain("Saved preferences");
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
    let settings: Record<string, unknown> = { responseLength: "auto", interactionIntensity: "balanced", version: 0 };
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      if (init?.method === "PUT") {
        const body = JSON.parse(String(init.body));
        writes.push(body);
        // Like the server: store the selection and answer with the full profile snapshot.
        const entry = catalog.items.find(item => item.id === body.conversationProfile?.id);
        settings = { ...body, version: body.version + 1, conversationProfile: entry ? {
          id: entry.id, version: entry.version, replyStyle: entry.replyStyle, answerMaxOutputTokens: entry.answerMaxOutputTokens,
          messageUnits: entry.messageUnits, costDreamcoins: entry.costDreamcoins } : undefined };
      }
      return Response.json({ settings, editable: true, catalog });
    }));
    await render();
    await choose("Conversation profile", "quick");
    expect(field("Reply length").value).toBe("short");
    expect(container.textContent).toContain("1 message · 0 Dreamcoins");
    expect(container.textContent).toContain("one to three sentences");
    expect(writes).toEqual([{ responseLength: "short", interactionIntensity: "balanced", sceneGeneration: "follow", version: 0, conversationProfile: { id: "quick", version: 1 } }]);
    await choose("Conversation profile", "story");
    await choose("Scene direction", "follow");
    expect(field("Conversation profile").value).toBe("custom");
  });
});
