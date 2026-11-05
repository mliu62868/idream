// @vitest-environment happy-dom
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CharacterCardData } from "@/types/ourdream";

vi.mock("next/link", () => ({ default: ({ href, children, ...props }: ComponentProps<"a">) => createElement("a", { ...props, href: String(href) }, children) }));
vi.mock("next/image", () => ({ default: ({ alt }: { alt: string }) => createElement("img", { alt }) }));
import { CharacterCard } from "@/components/ourdream/CharacterCard";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Recorded exposures live for the page, so every test uses its own exposure ids.
let run = 0;
let context: NonNullable<CharacterCardData["exposureContext"]>;
function card(overrides: Partial<CharacterCardData> = {}): CharacterCardData {
  return {
    id: "character-1", title: "Aster", age: "24", description: "A public character.",
    likes: "0", chats: "0", creator: "Official", image: "/character.png",
    exposureContext: context, ...overrides,
  };
}

class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = [];
  disconnected = false;
  constructor(private readonly callback: IntersectionObserverCallback) {
    FakeIntersectionObserver.instances.push(this);
  }
  observe() {}
  disconnect() { this.disconnected = true; }
  emit(ratio: number) {
    this.callback(
      [{ intersectionRatio: ratio, isIntersecting: ratio > 0 } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    );
  }
}
const latestObserver = () => FakeIntersectionObserver.instances.at(-1)!;

describe("shared Character exposure tracking", () => {
  let root: Root;
  let container: HTMLDivElement;
  let beacons: Array<{ name: string; props: Record<string, unknown> }>;

  beforeEach(() => {
    vi.useFakeTimers();
    run += 1;
    context = {
      contextToken: "signed-token",
      journeyId: "journey-1",
      placementId: "explore.feed",
      impressionExposureId: `impression-${run}`,
      detailExposureId: `detail-${run}`,
    };
    FakeIntersectionObserver.instances = [];
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
    beacons = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      beacons.push(JSON.parse(String(init?.body)));
      return Response.json({ ok: true, data: {} });
    }));
    Object.defineProperty(navigator, "sendBeacon", { configurable: true, value: undefined });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function mount(data = card()) {
    await act(async () => root.render(createElement(CharacterCard, { card: data })));
  }
  async function advance(ms: number) {
    await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
  }

  it("records an impression only after 50% visibility is held for 500ms", async () => {
    await mount();
    latestObserver().emit(0.4);
    await advance(1_000);
    expect(beacons).toEqual([]);

    latestObserver().emit(0.6);
    await advance(499);
    latestObserver().emit(0.2);
    await advance(1_000);
    expect(beacons).toEqual([]);

    latestObserver().emit(0.6);
    await advance(500);
    expect(beacons).toEqual([{
      name: "character.exposure.recorded.v2",
      props: {
        contextToken: "signed-token",
        characterId: "character-1",
        eventType: "eligible_impression",
        exposureId: context.impressionExposureId,
        journeyId: "journey-1",
        parentExposureId: null,
        placementId: "explore.feed",
        visibleDurationMs: 500,
        visibleRatio: 0.6,
      },
    }]);
  });

  it("sends one impression per journey + Character + placement across remounts and refetches", async () => {
    await mount();
    latestObserver().emit(1);
    await advance(500);
    expect(beacons).toHaveLength(1);

    // A refetch re-signs the same exposure; a remount loses component state.
    await mount(card({ exposureContext: { ...context, contextToken: "re-signed-token" } }));
    await act(async () => root.unmount());
    root = createRoot(container);
    await mount();
    for (const observer of FakeIntersectionObserver.instances) observer.emit(1);
    await advance(1_000);
    expect(beacons).toHaveLength(1);
  });

  it("links into the detail page with entry attribution and records detail_view once", async () => {
    await mount();
    latestObserver().emit(1);
    await advance(500);
    const link = container.querySelector("a")!;
    expect(link.getAttribute("href")).toBe(
      `/characters/character-1?entryExposureId=${context.detailExposureId}&journeyId=journey-1&placementId=explore.feed`,
    );
    link.addEventListener("click", (event) => event.preventDefault());
    await act(async () => { link.click(); link.click(); });
    expect(beacons.slice(1)).toEqual([{
      name: "character.exposure.recorded.v2",
      props: expect.objectContaining({
        eventType: "detail_view",
        exposureId: context.detailExposureId,
        parentExposureId: context.impressionExposureId,
        visibleDurationMs: 0,
        visibleRatio: 1,
      }),
    }]);
  });

  it("does not claim a detail view for a card that never earned an impression", async () => {
    await mount();
    const link = container.querySelector("a")!;
    link.addEventListener("click", (event) => event.preventDefault());
    await act(async () => link.click());
    expect(beacons).toEqual([]);
  });

  it("keeps today's plain link and no observer when there is no context", async () => {
    await mount(card({ exposureContext: null }));
    expect(container.querySelector("a")!.getAttribute("href")).toBe("/characters/character-1");
    expect(FakeIntersectionObserver.instances).toEqual([]);
  });
});
