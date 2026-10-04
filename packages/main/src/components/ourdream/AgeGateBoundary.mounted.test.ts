// @vitest-environment happy-dom

import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  usePathname: () => "/characters/character-1",
}));
vi.mock("next/image", () => ({
  default: (props: Record<string, unknown>) => createElement("img", props),
}));
vi.mock("next/link", () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) =>
    createElement("a", { href }, children),
}));

import { AGE_GATE_HINT_ATTRIBUTE, ageGateHintScript } from "@/lib/age-gate";
import { AgeGateBoundary } from "./AgeGateBoundary";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("AgeGateBoundary browser-history recovery", () => {
  let container: HTMLDivElement;
  let root: Root | undefined;
  let finishRestore: ((response: Response) => void) | undefined;

  beforeEach(() => {
    vi.stubGlobal("localStorage", memoryStorage());
    document.cookie = "AdultContentAcceptedOD=; path=/; max-age=0";
    const restoreResponse = new Promise<Response>((resolve) => {
      finishRestore = resolve;
    });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) =>
      String(input) === "/api/v1/age-gate/accept"
        ? restoreResponse
        : Response.json({
            ok: true,
            data: { user: null, ageGate: { accepted: false } },
          })
    ));
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    if (root) {
      await act(async () => root?.unmount());
    }
    container?.remove();
    vi.unstubAllGlobals();
  });

  it("unblocks a suspended page when bfcache returns with accepted local authority", async () => {
    await act(async () => {
      root?.render(
        createElement(
          AgeGateBoundary,
          null,
          createElement("main", null, "Character detail"),
        ),
      );
    });
    await act(async () => Promise.resolve());
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();

    localStorage.setItem("AdultContentAcceptedOD", "true");
    const restored = new Event("pageshow") as PageTransitionEvent;
    Object.defineProperty(restored, "persisted", { value: true });
    await act(async () => window.dispatchEvent(restored));

    expect(container.querySelector('[aria-label="Checking age access"]')).not
      .toBeNull();
    expect(fetch).toHaveBeenCalledWith(
      "/api/v1/age-gate/accept",
      expect.objectContaining({ method: "POST" }),
    );

    await act(async () => finishRestore?.(Response.json({ ok: true })));
    expect(container.querySelector('[aria-label="Checking age access"]')).toBeNull();
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(container.querySelector("[data-age-gate-content]")?.hasAttribute("inert"))
      .toBe(false);
  });
});

describe("age gate first-paint hint", () => {
  afterEach(() => {
    document.documentElement.removeAttribute(AGE_GATE_HINT_ATTRIBUTE);
    document.cookie = "AdultContentAcceptedOD=; path=/; max-age=0";
    vi.unstubAllGlobals();
  });

  it("marks the document only when the server-written acceptance cookie is present", () => {
    new Function(ageGateHintScript)();
    expect(document.documentElement.hasAttribute(AGE_GATE_HINT_ATTRIBUTE)).toBe(false);

    document.cookie = "AdultContentAcceptedOD=true; path=/";
    new Function(ageGateHintScript)();
    expect(document.documentElement.getAttribute(AGE_GATE_HINT_ATTRIBUTE)).toBe("accepted");
  });

  it("keeps protected content gated while hinted, and drops the hint when Main refuses", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    document.cookie = "AdultContentAcceptedOD=true; path=/";
    new Function(ageGateHintScript)();
    let finishRestore: ((response: Response) => void) | undefined;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => {
      finishRestore = resolve;
    })));
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(AgeGateBoundary, null, createElement("main", null, "Detail")));
    });

    // Overlay is still rendered (hidden by the hint CSS), content is still inert.
    const overlay = container.querySelector('[aria-label="Checking age access"]');
    expect(overlay?.className).toContain("[html[data-age-gate-hint=accepted]_&]:hidden");
    expect(container.querySelector("[data-age-gate-content]")?.hasAttribute("inert")).toBe(true);

    await act(async () => finishRestore?.(new Response(null, { status: 403 })));
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    expect(document.documentElement.hasAttribute(AGE_GATE_HINT_ATTRIBUTE)).toBe(false);

    await act(async () => root.unmount());
    container.remove();
  });
});

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}
