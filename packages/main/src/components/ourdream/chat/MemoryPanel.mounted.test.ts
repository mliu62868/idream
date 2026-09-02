// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MemoryPanel } from "./MemoryPanel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function render(sessionId?: string): Promise<void> {
  await act(async () => {
    root.render(createElement(MemoryPanel, {
      open: true,
      onClose: () => {},
      characterId: "raya-reyes",
      ...(sessionId ? { sessionId } : {}),
      memoryEnabled: true,
      memoryPending: false,
      onToggleMemory: () => {},
    }));
  });
}

function resetButton(): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>(
    '[data-testid="memory-clear"]',
  );
  if (!button) throw new Error("reset button missing");
  return button;
}

async function click(button: HTMLButtonElement): Promise<void> {
  await act(async () => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

async function fill(label: string, value: string) {
  const textarea = container.querySelector<HTMLTextAreaElement>(`[aria-label="${label}"]`);
  if (!textarea) throw new Error(`${label} missing`);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, value);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    textarea.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

describe("MemoryPanel clear", () => {
  it("loads saved user context and saves custom instructions with the displayed version", async () => {
    const item = { id: "instruction-1", kind: "custom_instruction", content: "Call me Robin.", version: 2 };
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PATCH") return Response.json({ item: { ...item, content: "Call me Robin, and keep replies brief.", version: 3 } });
      return Response.json({ items: [item, { id: "pin-1", kind: "pinned_memory", content: "My blue notebook is Harbor Finch.", version: 1 }] });
    });
    vi.stubGlobal("fetch", fetchMock);
    await render("session-1");
    expect(container.textContent).toContain("My blue notebook is Harbor Finch.");
    const textarea = container.querySelector<HTMLTextAreaElement>('[aria-label="Custom instructions"]');
    expect(textarea?.value).toBe("Call me Robin.");
    await fill("Custom instructions", "Call me Robin, and keep replies brief.");
    const save = container.querySelector<HTMLButtonElement>('[data-testid="chat-instructions-save"]');
    expect(save).not.toBeNull();
    await click(save!);
    const mutation = fetchMock.mock.calls.find(([, init]) => init?.method === "PATCH");
    expect(mutation?.[0]).toBe("/api/v1/chat/sessions/session-1/context-directives/instruction-1");
    expect(JSON.parse(String(mutation?.[1]?.body))).toEqual({ content: "Call me Robin, and keep replies brief.", version: 2 });
    expect(container.textContent).toContain("Saved for future messages.");
  });

  it("keeps a failed pin draft and retries the same create request without duplicating intent", async () => {
    let posts = 0;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        posts += 1;
        if (posts === 1) return Response.json({ error: { message: "Temporary failure" } }, { status: 503 });
        return Response.json({ item: { id: "pin-1", kind: "pinned_memory", content: "My tea is lapsang.", version: 1 } });
      }
      return Response.json({ items: [] });
    });
    vi.stubGlobal("fetch", fetchMock);
    await render("session-1");
    await fill("Pinned memory", "My tea is lapsang.");
    const add = () => [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Add pin")!;
    await click(add());
    expect(container.textContent).toContain("Temporary failure");
    expect(container.querySelector<HTMLTextAreaElement>('[aria-label="Pinned memory"]')?.value).toBe("My tea is lapsang.");
    await click(add());
    const requests = fetchMock.mock.calls.filter(([, init]) => init?.method === "POST");
    expect(new Headers(requests[0][1]?.headers).get("idempotency-key")).toBe(new Headers(requests[1][1]?.headers).get("idempotency-key"));
    expect(container.querySelector<HTMLTextAreaElement>('[aria-label="Pinned memory"]')?.value).toBe("");
    expect(container.textContent).toContain("1/8");
  });

  it("discards a late context response when the viewed session changes", async () => {
    let release!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      if (String(input).includes("session-1")) return new Promise<Response>((resolve) => { release = resolve; });
      return Promise.resolve(Response.json({ items: [{ id: "pin-2", kind: "pinned_memory", content: "Second user's detail.", version: 1 }] }));
    }));
    await render("session-1");
    await render("session-2");
    expect(container.textContent).toContain("Second user's detail.");
    await act(async () => release(Response.json({ items: [{ id: "pin-1", kind: "pinned_memory", content: "First user's private detail.", version: 1 }] })));
    expect(container.textContent).not.toContain("First user's private detail.");
    expect(container.textContent).toContain("Second user's detail.");
  });

  it("does not let a failed initial read overwrite unseen saved instructions", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({}, { status: 500 })));
    await render("session-1");
    expect(container.querySelector<HTMLTextAreaElement>('[aria-label="Custom instructions"]')?.disabled).toBe(true);
    expect(container.querySelector<HTMLButtonElement>('[data-testid="chat-instructions-save"]')?.disabled).toBe(true);
    expect(container.textContent).toContain("Reload settings");
  });

  it("starts a fresh conversation after the reset succeeds", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/memory/")) {
        return new Response(JSON.stringify({ ok: true, archivedSessions: 1 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({ ok: true, data: { session: { id: "sess_new" } } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    await render();
    await click(resetButton());
    // Reset is destructive, so the first click only arms the confirm.
    expect(fetchMock).not.toHaveBeenCalled();
    await click(resetButton());

    const calls = fetchMock.mock.calls.map(([input]) => String(input));
    expect(calls[0]).toContain("/api/v1/chat/memory/raya-reyes");
    // Without this the user is left sitting in a session the reset just archived,
    // where every send comes back "This chat has been archived".
    expect(calls[1]).toBe("/api/v1/chat/sessions");
    expect(window.location.href).toContain("/chat/sess_new");
  });

  it("does not claim a reset failure was a no-op", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);

    await render();
    await click(resetButton());
    await click(resetButton());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(
      container.querySelector('[data-testid="memory-clear-error"]')?.textContent,
    ).toContain("Old chats may already be archived");
  });
});
