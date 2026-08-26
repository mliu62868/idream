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
});

async function render(): Promise<void> {
  await act(async () => {
    root.render(createElement(MemoryPanel, {
      open: true,
      onClose: () => {},
      characterId: "raya-reyes",
      memoryEnabled: true,
      memoryPending: false,
      onToggleMemory: () => {},
      onRelationshipReset: () => {},
    }));
  });
}

function resetButton(): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>(
    '[data-testid="relationship-reset"]',
  );
  if (!button) throw new Error("reset button missing");
  return button;
}

async function click(button: HTMLButtonElement): Promise<void> {
  await act(async () => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("MemoryPanel relationship reset", () => {
  it("starts a fresh conversation after the reset succeeds", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/relationships/")) {
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
    expect(calls[0]).toContain("/api/v1/chat/relationships/raya-reyes");
    // Without this the user is left sitting in a session the reset just archived,
    // where every send comes back "This chat has been archived".
    expect(calls[1]).toBe("/api/v1/chat/sessions");
    expect(window.location.href).toContain("/chat/sess_new");
  });

  it("says nothing changed when the reset call fails", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);

    await render();
    await click(resetButton());
    await click(resetButton());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(
      container.querySelector('[data-testid="relationship-reset-error"]')?.textContent,
    ).toContain("Nothing was changed");
  });
});
