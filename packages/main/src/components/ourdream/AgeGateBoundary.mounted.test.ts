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
