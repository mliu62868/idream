// @vitest-environment happy-dom

import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: ComponentProps<"a">) =>
    createElement("a", { href, ...props }, children),
}));
vi.mock("next/image", () => ({
  default: ({ fill: _fill, unoptimized: _unoptimized, ...props }: ComponentProps<"img"> & {
    fill?: boolean;
    unoptimized?: boolean;
  }) => createElement("img", props),
}));
vi.mock("./AgeGateBoundary", () => ({ useAgeGateAccess: () => ({ accepted: true }) }));

import { CreateWorkspace, draftStorageKeyForScope, initialCharacterDraft } from "./CreateWorkspace";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("CreateWorkspace identity confirmation", () => {
  let container: HTMLDivElement;
  let root: Root;
  let releaseConfirmation: ((response: Response) => void) | undefined;

  beforeEach(() => {
    const entries = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => entries.get(key) ?? null,
      setItem: (key: string, value: string) => entries.set(key, value),
      removeItem: (key: string) => entries.delete(key),
      clear: () => entries.clear(),
    });
    window.localStorage.setItem(draftStorageKeyForScope("user:creator-1"), JSON.stringify({
      ...initialCharacterDraft(),
      draftId: "draft-1",
      step: 3,
      name: "Avery",
      description: "Warm and direct",
      firstMessage: "Hello there",
      previewBatch: {
        phase: "complete",
        currentCandidateNumber: 4,
        activeRequestKey: "",
        activePreviewJobId: "",
        activeJobStatus: null,
        candidates: Array.from({ length: 4 }, (_, index) => ({
          previewJobId: `preview-${index + 1}`,
          assetId: `asset-${index + 1}`,
          url: `/api/v1/media/asset-${index + 1}/content`,
          isSynthetic: false,
        })),
        deadlineAt: Date.now() + 60_000,
        failureReason: null,
        errorMessage: "",
      },
    }));
    const confirmation = new Promise<Response>((resolve) => { releaseConfirmation = resolve; });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/v1/me") {
        return Response.json({ ok: true, data: { user: { id: "creator-1" }, anonymousId: null } });
      }
      if (url === "/api/v1/character-templates") {
        return Response.json({ ok: true, data: { items: [] } });
      }
      if (url === "/api/v1/character-voices") return Response.json({ ok: true, data: {
        provider: "pocket_tts", defaultVoiceId: "alba", items: [
          { id: "alba", label: "Alba", description: "Official English voice" },
          { id: "marius", label: "Marius", description: "Official English voice" },
        ],
      } });
      if (url === "/api/v1/character-voices/preview") return Response.json({ ok: true, data: {
        voiceId: "marius", contentType: "audio/wav", audioBase64: "UklGRg==", durationMs: 1000,
      } });
      if (url.endsWith("/preview-anchor")) return confirmation;
      return Response.json({ ok: true, data: {} });
    }));
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    window.localStorage.clear();
    vi.unstubAllGlobals();
  });

  it("explains that unlisted sharing requires review and publication", async () => {
    const key = draftStorageKeyForScope("user:creator-1");
    const saved = JSON.parse(window.localStorage.getItem(key)!);
    window.localStorage.setItem(key, JSON.stringify({
      ...saved, step: 4, visibility: "unlisted", confirmedPreviewJobId: "preview-1",
      confirmedPreviewUrl: "/api/v1/media/asset-1/content",
    }));
    await act(async () => root.render(createElement(CreateWorkspace)));
    await waitUntil(() => Boolean(container.querySelector('[data-testid="create-submit"]')));
    expect(container.querySelector('[data-testid="create-submit"]')?.textContent).toContain("Submit for review");
    expect(container.textContent).toContain("After review and publication, unlisted characters are reachable by direct link and stay out of Explore.");
  });

  it("holds the selected identity and traits steady until confirmation finishes", async () => {
    await act(async () => root.render(createElement(CreateWorkspace)));
    await waitUntil(() => Boolean(container.querySelector('[data-testid="create-confirm-identity"]')));
    const candidates = () => [...container.querySelectorAll<HTMLButtonElement>(
      '[data-testid="create-preview-candidates"] button',
    )];
    const editTraits = () => [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("Edit traits"));

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="create-confirm-identity"]')?.click();
    });
    expect(candidates()[1]?.disabled).toBe(true);
    expect(editTraits()?.disabled).toBe(true);
    await act(async () => candidates()[1]?.click());
    await act(async () => releaseConfirmation?.(Response.json({ ok: true, data: {} })));

    expect(candidates()[0]?.getAttribute("aria-pressed")).toBe("true");
    expect(candidates()[0]?.textContent).toContain("Identity confirmed");
    expect(candidates()[1]?.getAttribute("aria-pressed")).toBe("false");
    expect(candidates()[1]?.disabled).toBe(false);
  });

  it("restores a completed unconfirmed preview from the server on another device", async () => {
    window.localStorage.clear();
    const originalFetch = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input) === "/api/v1/character-drafts/current") {
        return Response.json({ ok: true, data: {
          draft: {
            id: "draft-1", step: 3, name: "Avery", gender: "female", style: "realistic",
            appearance: { prompt: "Dark hair" }, hair: {}, body: {}, tags: [],
            advancedDetails: { age: 25, description: "Warm and direct", firstMessage: "Hello there" },
            previewJobId: null,
          },
          previewJob: { id: "saved-preview", status: "completed" },
          asset: { id: "saved-asset", url: "/api/v1/media/saved-asset/content", isSynthetic: false },
        } });
      }
      return originalFetch(input, init);
    });
    await act(async () => root.render(createElement(CreateWorkspace)));
    await waitUntil(() => Boolean(container.querySelector('[data-testid="create-step-preview"]')));

    expect(container.querySelector('img[src="/api/v1/media/saved-asset/content"]')).not.toBeNull();
    expect(container.querySelector<HTMLButtonElement>('[data-testid="create-confirm-identity"]')?.disabled)
      .toBe(false);
    expect(vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);

    await act(async () => root.render(null));
    await act(async () => root.render(createElement(CreateWorkspace)));
    await waitUntil(() => Boolean(container.querySelector('[data-testid="create-step-preview"]')));
    expect(container.querySelector('img[src="/api/v1/media/saved-asset/content"]')).not.toBeNull();
    expect(container.querySelector<HTMLButtonElement>('[data-testid="create-confirm-identity"]')?.disabled)
      .toBe(false);
  });

  it("restores an unknown server preview and only checks that exact job on a new device", async () => {
    window.localStorage.clear();
    const originalFetch = vi.mocked(fetch).getMockImplementation()!;
    let completed = false;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = String(input);
      const previewJob = { id: "unknown-preview", status: completed ? "completed" : "queued", errorCode: completed ? null : "provider_outcome_unknown" };
      const asset = completed ? { id: "resolved-asset", url: "/api/v1/media/resolved-asset/content" } : null;
      if (url === "/api/v1/character-drafts/current") return Response.json({ ok: true, data: {
        draft: { id: "draft-1", step: 3, name: "Avery", gender: "female", style: "realistic",
          appearance: {}, hair: {}, body: {}, tags: [], advancedDetails: { age: 25, description: "Warm and direct", firstMessage: "Hello" }, previewJobId: null },
        previewJob, asset,
      } });
      if (url === "/api/v1/character-drafts/draft-1/preview?previewJobId=unknown-preview") return Response.json({ ok: true, data: { previewJob, asset } });
      return originalFetch(input, init);
    });
    await act(async () => root.render(createElement(CreateWorkspace)));
    await waitUntil(() => Boolean(container.querySelector('[data-testid="create-step-preview"]')));
    const check = () => [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.trim() === "Check preview status");
    expect(check()).toBeDefined();
    expect(container.textContent).toContain("unknown-preview");
    expect(container.querySelector('a[href="/helpdesk"]')).not.toBeNull();
    await act(async () => check()?.click());
    expect(check()).toBeDefined();
    completed = true;
    await act(async () => check()?.click());
    expect(container.querySelector('img[src="/api/v1/media/resolved-asset/content"]')).not.toBeNull();
    expect(vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
  });

  it("restores structured appearance across devices and saves every visible trait", async () => {
    window.localStorage.clear();
    const originalFetch = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input) === "/api/v1/character-drafts/current") {
        return Response.json({ ok: true, data: { draft: {
          id: "draft-1", step: 1, name: "Avery", gender: "female", style: "realistic",
          appearance: { prompt: "Freckles", ethnicity: "Latina", skinTone: "Olive", eyes: "Green", faceShape: "Oval" },
          hair: { color: "auburn", style: "short curls" }, body: { type: "Athletic" }, tags: [],
          advancedDetails: { age: 25, description: "Warm and direct", firstMessage: "Hello there" }, previewJobId: null,
        } } });
      }
      return originalFetch(input, init);
    });
    await act(async () => root.render(createElement(CreateWorkspace)));
    await waitUntil(() => Boolean(container.querySelector('[data-testid="create-step-appearance"]')));
    expect(field("Ethnicity / fantasy race").value).toBe("Latina");
    expect(field("Skin tone").value).toBe("Olive");
    expect(field("Eye color").value).toBe("Green");
    expect(field("Face shape / features").value).toBe("Oval");
    expect(field("Hair").value).toBe("color: auburn, style: short curls");
    await changeField("Eye color", "Hazel");
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.trim() === "Next")?.click());
    const saved = vi.mocked(fetch).mock.calls.find(([input, init]) => String(input) === "/api/v1/character-drafts/draft-1" && init?.method === "PATCH");
    expect(JSON.parse(String(saved?.[1]?.body))).toMatchObject({
      appearance: { prompt: "Freckles", ethnicity: "Latina", skinTone: "Olive", eyes: "Hazel", faceShape: "Oval" },
      hair: { prompt: "color: auburn, style: short curls" }, body: { type: "Athletic" },
    });
  });

  it.each(["none", "appearance", "voice"])("recovers a missing candidate when visual inputs match and preserves local choices (changed=%s)", async (changed) => {
    const voiceSelection = changed === "voice" ? { provider: "pocket_tts", voiceId: "marius" } : null;
    window.localStorage.setItem(draftStorageKeyForScope("user:creator-1"), JSON.stringify({
      ...initialCharacterDraft(), draftId: "draft-1", step: 3, name: "Avery", description: "Warm and direct", firstMessage: "Hello there",
      appearance: changed === "appearance" ? "Unsaved freckles" : "Dark hair", previewBatch: null, voiceSelection,
    }));
    const originalFetch = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input) === "/api/v1/character-drafts/current") return Response.json({ ok: true, data: {
        draft: { id: "draft-1", step: 3, name: "Avery", gender: "female", style: "realistic", appearance: { prompt: "Dark hair" }, hair: {}, body: {}, tags: [],
          advancedDetails: { age: 21, description: "Warm and direct", firstMessage: "Hello there" }, previewJobId: null },
        previewJob: { id: "saved-preview", status: "completed" },
        asset: { id: "saved-asset", url: "/api/v1/media/saved-asset/content", isSynthetic: false },
      } });
      return originalFetch(input, init);
    });
    await act(async () => root.render(createElement(CreateWorkspace)));
    await waitUntil(() => Boolean(container.querySelector('[data-testid="create-step-preview"]')));
    expect(Boolean(container.querySelector('img[src="/api/v1/media/saved-asset/content"]'))).toBe(changed !== "appearance");
    const stored = JSON.parse(window.localStorage.getItem(draftStorageKeyForScope("user:creator-1"))!);
    expect(stored.appearance).toBe(changed === "appearance" ? "Unsaved freckles" : "Dark hair");
    expect(stored.voiceSelection).toEqual(voiceSelection);
    expect(vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
  });

  it("authors guided Soul fields into the same Markdown and restores edited details", async () => {
    window.localStorage.setItem(draftStorageKeyForScope("user:creator-1"), JSON.stringify({
      ...initialCharacterDraft(), draftId: "draft-1", step: 2, name: "Avery", description: "Warm and direct",
      firstMessage: "Hello there", detailsMarkdown: "A quiet history.\n\n## Occupation\nAstronomer\n\n## Boundaries\nAsk before changing the subject.",
    }));
    await act(async () => root.render(createElement(CreateWorkspace)));
    await waitUntil(() => Boolean(container.querySelector('[data-testid="create-step-soul"]')));
    expect(field("Occupation").value).toBe("Astronomer");
    await changeField("Occupation", "Radio host");
    await changeField("Relationship", "Childhood friend");
    await changeField("Personality", "Warm and curious");
    await changeField("Hobbies", "Stargazing, jazz");
    await changeField("Fetishes and preferences", "Playful flirting");
    const markdown = field("Additional details (optional)").value;
    expect(markdown).toContain("## Occupation\nRadio host");
    expect(markdown).not.toContain("Astronomer");
    expect(markdown).toContain("## Relationship\nChildhood friend");
    expect(markdown).toContain("## Boundaries\nAsk before changing the subject.");
    expect(markdown).toContain("## Hobbies\nStargazing, jazz");
    await changeField("Additional details (optional)", markdown.replace("Radio host", "Librarian"));
    expect(field("Occupation").value).toBe("Librarian");
    await act(async () => root.render(null));
    await act(async () => root.render(createElement(CreateWorkspace)));
    await waitUntil(() => Boolean(container.querySelector('[data-testid="create-step-soul"]')));
    expect(field("Occupation").value).toBe("Librarian");
    expect(field("Relationship").value).toBe("Childhood friend");
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.trim() === "Next")?.click());
    const saved = vi.mocked(fetch).mock.calls.find(([input, init]) => String(input) === "/api/v1/character-drafts/draft-1" && init?.method === "PATCH");
    expect(JSON.parse(String(saved?.[1]?.body)).advancedDetails).toMatchObject({ detailsMarkdown: expect.stringContaining("## Occupation\nLibrarian") });
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.trim() === "Back")?.click());
    await changeField("Additional details (optional)", "x".repeat(24_000));
    await changeField("Occupation", "Doctor");
    expect(field("Additional details (optional)").value).toBe("x".repeat(24_000));
    expect(container.textContent).toContain("Additional details must be 24,000 characters or fewer.");
  });

  it("selects and previews a real catalog voice, then saves and restores the exact selection", async () => {
    window.localStorage.setItem(draftStorageKeyForScope("user:creator-1"), JSON.stringify({
      ...initialCharacterDraft(), draftId: "draft-1", step: 2, name: "Avery", description: "Warm and direct", firstMessage: "Hello there",
    }));
    await act(async () => root.render(createElement(CreateWorkspace)));
    await waitUntil(() => Boolean(container.querySelector('[data-testid="create-step-soul"]')));
    const select = container.querySelector<HTMLSelectElement>('[data-testid="create-voice-select"]');
    expect(select).not.toBeNull();
    expect(select!.textContent).toContain("Marius");
    await act(async () => { select!.value = "marius"; select!.dispatchEvent(new Event("change", { bubbles: true })); });
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="create-voice-preview"]')?.click());
    expect(container.querySelector("audio")?.getAttribute("src")).toBe("data:audio/wav;base64,UklGRg==");
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.trim() === "Next")?.click());
    const saved = vi.mocked(fetch).mock.calls.find(([input, init]) => String(input) === "/api/v1/character-drafts/draft-1" && init?.method === "PATCH");
    expect(JSON.parse(String(saved?.[1]?.body)).advancedDetails.voiceSelection).toEqual({ provider: "pocket_tts", voiceId: "marius" });
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.trim() === "Back")?.click());
    await act(async () => root.render(null));
    await act(async () => root.render(createElement(CreateWorkspace)));
    await waitUntil(() => Boolean(container.querySelector('[data-testid="create-step-soul"]')));
    expect(container.querySelector<HTMLSelectElement>('[data-testid="create-voice-select"]')?.value).toBe("marius");
  });

  it("discards an old voice preview when another voice is selected", async () => {
    window.localStorage.setItem(draftStorageKeyForScope("user:creator-1"), JSON.stringify({
      ...initialCharacterDraft(), draftId: "draft-1", step: 2, name: "Avery", description: "Warm and direct", firstMessage: "Hello there",
      voiceSelection: { provider: "pocket_tts", voiceId: "marius" },
    }));
    let finishPreview!: (response: Response) => void;
    const pendingPreview = new Promise<Response>(resolve => { finishPreview = resolve; });
    const originalFetch = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation((input, init) => String(input) === "/api/v1/character-voices/preview" ? pendingPreview : originalFetch(input, init));
    await act(async () => root.render(createElement(CreateWorkspace)));
    await waitUntil(() => Boolean(container.querySelector('[data-testid="create-step-soul"]')));
    const select = container.querySelector<HTMLSelectElement>('[data-testid="create-voice-select"]');
    expect(select).not.toBeNull();
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="create-voice-preview"]')?.click());
    await act(async () => { select!.value = "alba"; select!.dispatchEvent(new Event("change", { bubbles: true })); });
    await act(async () => finishPreview(Response.json({ ok: true, data: { voiceId: "marius", contentType: "audio/wav", audioBase64: "UklGRg==", durationMs: 1000 } })));
    expect(container.querySelector("audio")).toBeNull();
    expect(select!.value).toBe("alba");
    expect(container.querySelector<HTMLButtonElement>('[data-testid="create-voice-preview"]')?.disabled).toBe(false);
  });

  function field(label: string): HTMLInputElement | HTMLTextAreaElement {
    const wrapper = [...container.querySelectorAll("label")].find(item => item.querySelector("span")?.textContent === label);
    const input = wrapper?.querySelector<HTMLInputElement | HTMLTextAreaElement>("input,textarea");
    if (!input) throw new Error(`Missing field: ${label}`);
    return input;
  }

  async function changeField(label: string, value: string) {
    const input = field(label);
    await act(async () => {
      const prototype = input.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  async function waitUntil(predicate: () => boolean) {
    const deadline = Date.now() + 2_000;
    while (!predicate()) {
      if (Date.now() >= deadline) throw new Error(`Create workspace did not load: ${container.textContent}`);
      await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    }
  }
});
