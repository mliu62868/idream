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
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(window.location.search),
}));

import { CreateWorkspace, draftStorageKeyForScope, initialCharacterDraft } from "./CreateWorkspace";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
beforeEach(() => window.history.replaceState(null, "", "/create"));

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

  function savePendingPreview(phase: "running" | "paused" = "running") {
    const key = draftStorageKeyForScope("user:creator-1");
    const saved = JSON.parse(window.localStorage.getItem(key)!);
    saved.previewBatch = {
      ...saved.previewBatch, phase, currentCandidateNumber: 4,
      activeRequestKey: "preview-original-request", activePreviewJobId: "preview-4",
      activeJobStatus: "running", candidates: saved.previewBatch.candidates.slice(0, 3),
      deadlineAt: Date.now() - 60_000, failureReason: phase === "paused" ? "user_paused" : null,
    };
    window.localStorage.setItem(key, JSON.stringify(saved));
    return key;
  }

  function interceptPreview(read: () => Promise<Response>) {
    const originalFetch = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation((input, init) =>
      String(input) === "/api/v1/character-drafts/draft-1/preview?previewJobId=preview-4"
        ? read() : originalFetch(input, init));
  }

  function completedPreviewResponse() {
    return Response.json({ ok: true, data: {
      previewJob: { id: "preview-4", status: "completed" },
      asset: { id: "asset-4", url: "/api/v1/media/asset-4/content", isSynthetic: false },
    } });
  }

  it("opens the exact older draft from Studio and leaves the latest browser draft alone", async () => {
    const latest = window.localStorage.getItem(draftStorageKeyForScope("user:creator-1"));
    window.history.replaceState(null, "", "/create?draft=older-draft");
    const originalFetch = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation((input, init) => String(input) === "/api/v1/character-drafts/older-draft"
      ? Promise.resolve(Response.json({ ok: true, data: { draft: {
        id: "older-draft", updatedAt: "2026-10-01T00:00:00.000Z", step: 0, name: "Older saved character",
        appearance: {}, hair: {}, body: {}, tags: [], advancedDetails: { age: 25 }, previewJobId: null,
      } } })) : originalFetch(input, init));
    await act(async () => root.render(createElement(CreateWorkspace)));
    await waitUntil(() => container.querySelector<HTMLInputElement>('input[placeholder="Nova Reyes"]')?.value === "Older saved character");
    expect(window.localStorage.getItem(draftStorageKeyForScope("user:creator-1"))).toBe(latest);
    expect(JSON.parse(window.localStorage.getItem(`${draftStorageKeyForScope("user:creator-1")}:draft:older-draft`)!)).toMatchObject({
      draftId: "older-draft", draftUpdatedAt: "2026-10-01T00:00:00.000Z",
    });
    expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input).endsWith("/current"))).toBe(false);
    expect(vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
  });

  it("shows a missing explicit draft instead of editing the latest draft", async () => {
    window.history.replaceState(null, "", "/create?draft=missing-draft");
    const originalFetch = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation((input, init) => String(input) === "/api/v1/character-drafts/missing-draft"
      ? Promise.resolve(Response.json({ ok: false, error: { message: "This draft is no longer available." } }, { status: 404 }))
      : originalFetch(input, init));
    await act(async () => root.render(createElement(CreateWorkspace)));
    await waitUntil(() => container.textContent?.includes("This draft is no longer available.") === true);
    expect(container.querySelector('input[placeholder="Nova Reyes"]')).toBeNull();
    expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input).endsWith("/current"))).toBe(false);
  });

  it("discards an older draft read after navigation to another exact draft", async () => {
    window.localStorage.clear();
    window.history.replaceState(null, "", "/create?draft=older-draft");
    let finishOld!: (value: Response) => void;
    const oldRead = new Promise<Response>(resolve => { finishOld = resolve; });
    const originalFetch = vi.mocked(fetch).getMockImplementation()!;
    const payload = (id: string, name: string) => Response.json({ ok: true, data: { draft: {
      id, updatedAt: "2026-10-01T00:00:00.000Z", step: 0, name,
      appearance: {}, hair: {}, body: {}, tags: [], advancedDetails: { age: 25 }, previewJobId: null,
    } } });
    vi.mocked(fetch).mockImplementation((input, init) => {
      if (String(input) === "/api/v1/character-drafts/older-draft") return oldRead;
      if (String(input) === "/api/v1/character-drafts/newer-draft") return Promise.resolve(payload("newer-draft", "Newer saved character"));
      return originalFetch(input, init);
    });
    await act(async () => root.render(createElement(CreateWorkspace)));
    await waitUntil(() => vi.mocked(fetch).mock.calls.some(([input]) => String(input) === "/api/v1/character-drafts/older-draft"));
    window.history.replaceState(null, "", "/create?draft=newer-draft");
    await act(async () => root.render(createElement(CreateWorkspace)));
    await waitUntil(() => container.querySelector<HTMLInputElement>('input[placeholder="Nova Reyes"]')?.value === "Newer saved character");
    await act(async () => finishOld(payload("older-draft", "Late older character")));
    expect(container.querySelector<HTMLInputElement>('input[placeholder="Nova Reyes"]')?.value).toBe("Newer saved character");
    expect(window.localStorage.getItem(`${draftStorageKeyForScope("user:creator-1")}:draft:older-draft`)).toBeNull();
  });

  it("rejects ambiguous draft and character edit sources before reading either", async () => {
    window.history.replaceState(null, "", "/create?draft=older-draft&edit=character-1");
    await act(async () => root.render(createElement(CreateWorkspace)));
    expect(container.textContent).toContain("Choose one draft or character to edit.");
    expect(vi.mocked(fetch).mock.calls.filter(([input]) => String(input).includes("character-drafts") || String(input).includes("edit-draft"))).toHaveLength(0);
  });

  it("reloads an expired running batch and reconciles the same completed job", async () => {
    savePendingPreview();
    interceptPreview(async () => completedPreviewResponse());
    await act(async () => root.render(createElement(CreateWorkspace)));
    await waitUntil(() => container.querySelector('[data-testid="create-preview-progress"]')?.textContent?.includes("4 completed") === true);
    expect(container.querySelector('[data-testid="create-preview-progress"]')?.textContent).not.toContain("failed");
    expect(vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
  });

  it("checks a paused request without enqueueing a replacement candidate", async () => {
    savePendingPreview("paused");
    interceptPreview(async () => completedPreviewResponse());
    await act(async () => root.render(createElement(CreateWorkspace)));
    await waitUntil(() => container.textContent?.includes("checking paused") === true);
    const readCount = () => vi.mocked(fetch).mock.calls.filter(([input]) => String(input).includes("preview?previewJobId="));
    expect(readCount()).toHaveLength(0);
    const check = [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.trim() === "Check preview status");
    expect(check).toBeDefined();
    await act(async () => check?.click());
    await waitUntil(() => container.querySelector('[data-testid="create-preview-progress"]')?.textContent?.includes("4 completed") === true);
    expect(readCount()).toHaveLength(1);
    expect(vi.mocked(fetch).mock.calls.filter(([input, init]) => String(input).endsWith("/preview") && init?.method === "POST")).toHaveLength(0);
  });

  it("offers only pause checking until the first preview image is ready", async () => {
    const key = savePendingPreview();
    const saved = JSON.parse(window.localStorage.getItem(key)!);
    saved.previewBatch = { ...saved.previewBatch, currentCandidateNumber: 1, candidates: [] };
    window.localStorage.setItem(key, JSON.stringify(saved));
    let finishRead!: (response: Response) => void;
    interceptPreview(() => new Promise<Response>(resolve => { finishRead = resolve; }));
    await act(async () => root.render(createElement(CreateWorkspace)));
    await waitUntil(() => [...container.querySelectorAll("button")].some(button => button.textContent === "Pause checking"));
    expect(container.textContent).not.toContain("Choose a ready image");
    expect(container.querySelector('[data-testid="create-confirm-identity"]')).toBeNull();
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Pause checking")?.click());
    await act(async () => finishRead(completedPreviewResponse()));
    expect(container.textContent).toContain("Checking is paused");
    expect(container.querySelector('[data-testid="create-confirm-identity"]')).toBeNull();
    expect(JSON.parse(window.localStorage.getItem(key)!).previewBatch.candidates).toHaveLength(0);
    expect(vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
  });

  it("offers a ready image before the batch finishes and ignores the old poll's late result", async () => {
    const key = savePendingPreview();
    let finishRead!: (response: Response) => void;
    const read = new Promise<Response>(resolve => { finishRead = resolve; });
    interceptPreview(() => read);
    await act(async () => root.render(createElement(CreateWorkspace)));
    await waitUntil(() => Boolean(container.querySelector('[data-testid="create-step-preview"]')));
    const choose = [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Choose a ready image");
    expect(choose).toBeDefined();
    expect(container.textContent).toContain("This pauses checking and prevents further image requests. Images already requested will keep generating.");
    await act(async () => choose?.click());
    expect(container.querySelector<HTMLButtonElement>('[data-testid="create-confirm-identity"]')?.disabled).toBe(false);
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="create-confirm-identity"]')?.click());
    await act(async () => releaseConfirmation?.(Response.json({ ok: true, data: {} })));
    await act(async () => finishRead(completedPreviewResponse()));
    expect(container.textContent).toContain("Identity confirmed");
    const saved = JSON.parse(window.localStorage.getItem(key)!);
    expect(saved.previewBatch.phase).toBe("paused");
    expect(saved.previewBatch.failureReason).toBe("user_paused");
    expect(saved.previewBatch.candidates).toHaveLength(3);
    expect(saved.confirmedPreviewJobId).toBe("preview-1");
    expect(vi.mocked(fetch).mock.calls.filter(([input, init]) => String(input).endsWith("/preview") && init?.method === "POST")).toHaveLength(0);
    await act(async () => root.render(null));
    await act(async () => root.render(createElement(CreateWorkspace)));
    await waitUntil(() => container.textContent?.includes("Identity confirmed") === true);
    expect(container.textContent).toContain("checking paused");
    expect([...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Next")?.disabled).toBe(false);
  });

  it("explains that unlisted sharing starts after publication", async () => {
    const key = draftStorageKeyForScope("user:creator-1");
    const saved = JSON.parse(window.localStorage.getItem(key)!);
    window.localStorage.setItem(key, JSON.stringify({
      ...saved, step: 4, visibility: "unlisted", confirmedPreviewJobId: "preview-1",
      confirmedPreviewUrl: "/api/v1/media/asset-1/content",
    }));
    await act(async () => root.render(createElement(CreateWorkspace)));
    await waitUntil(() => Boolean(container.querySelector('[data-testid="create-submit"]')));
    expect(container.querySelector('[data-testid="create-submit"]')?.textContent).toContain("Save for sharing");
    expect(container.textContent).toContain("After publication, unlisted characters are reachable by direct link and stay out of Explore.");
  });

  it.each(["private", "unlisted", "public"])("uses the saved %s visibility to explain an automatically approved submission", async (visibility) => {
    const key = draftStorageKeyForScope("user:creator-1");
    const saved = JSON.parse(window.localStorage.getItem(key)!);
    window.localStorage.setItem(key, JSON.stringify({
      ...saved, step: 4, visibility, confirmedPreviewJobId: "preview-1",
      confirmedPreviewUrl: "/api/v1/media/asset-1/content",
    }));
    const originalFetch = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input) === "/api/v1/character-drafts/draft-1/submit") {
        expect(JSON.parse(String(init?.body))).toEqual({ visibility });
        return Response.json({ ok: true, data: { character: {
          id: "created-1", name: "Avery", status: "approved", visibility,
        } } });
      }
      return originalFetch(input, init);
    });
    await act(async () => root.render(createElement(CreateWorkspace)));
    await waitUntil(() => Boolean(container.querySelector('[data-testid="create-submit"]')));
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="create-submit"]')?.click());
    const status = container.querySelector('[data-testid="create-status"]');
    if (visibility === "private") {
      expect(status?.textContent).toBe("Saved Avery to My AI.");
      expect(container.querySelector('a[href="/characters/created-1"]')?.textContent).toContain("Open character");
    } else {
      expect(status?.textContent).toBe("Avery is saved and awaiting publication preparation. Sharing starts after publication.");
      expect(container.querySelector('a[href="/characters/created-1"]')).toBeNull();
      expect([...container.querySelectorAll("a")].find((link) => link.textContent?.trim() === "View in My AI")?.getAttribute("href")).toBe("/custom");
    }
  });

  it.each([409, 401])("locks the original private input on account switch/session loss (%s) even without a focus event", async (status) => {
    const key = draftStorageKeyForScope("user:creator-1");
    window.localStorage.setItem(key, JSON.stringify({ ...initialCharacterDraft(), name: "Private original input" }));
    const originalFetch = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input) === "/api/v1/character-drafts" && init?.method === "POST") {
        expect(new Headers(init.headers).get("x-idream-viewer-scope")).toBe("user:creator-1");
        return Response.json({ ok: false, error: { message: status === 409 ? "Your account changed. Reload this page." : "Unauthorized" } }, { status });
      }
      return originalFetch(input, init);
    });
    await act(async () => root.render(createElement(CreateWorkspace)));
    await waitUntil(() => Boolean(container.querySelector('[data-testid="create-step-identity"]')));
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.trim() === "Next")?.click());
    expect(container.querySelector('[data-testid="create-viewer-changed"]')).not.toBeNull();
    expect(container.textContent).not.toContain("Private original input");
    expect(JSON.parse(window.localStorage.getItem(key)!).name).toBe("Private original input");
    expect(window.localStorage.getItem(draftStorageKeyForScope("user:creator-2"))).toBeNull();
    expect(vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(0);
  });

  it("hides private fields on focus after a viewer switch and discards a late confirmation", async () => {
    await act(async () => root.render(createElement(CreateWorkspace)));
    await waitUntil(() => Boolean(container.querySelector('[data-testid="create-confirm-identity"]')));
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="create-confirm-identity"]')?.click());
    const originalFetch = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation((input, init) => String(input) === "/api/v1/me"
      ? Promise.resolve(Response.json({ ok: true, data: { user: { id: "creator-2" }, anonymousId: null } }))
      : originalFetch(input, init));
    await act(async () => window.dispatchEvent(new Event("focus")));
    await act(async () => releaseConfirmation?.(Response.json({ ok: true, data: {} })));
    expect(container.querySelector('[data-testid="create-viewer-changed"]')).not.toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(window.localStorage.getItem(draftStorageKeyForScope("user:creator-2"))).toBeNull();
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
          previewCandidates: [{ previewJobId: "saved-preview", assetId: "saved-asset", url: "/api/v1/media/saved-asset/content", isSynthetic: false }],
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

  it("restores every completed candidate on another device even when the latest preview failed", async () => {
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
          previewJob: { id: "failed-preview", status: "failed", errorCode: "backend_error" },
          asset: null,
          previewCandidates: [
            { previewJobId: "preview-b", assetId: "asset-b", url: "/api/v1/media/asset-b/content", isSynthetic: false },
            { previewJobId: "preview-a", assetId: "asset-a", url: "/api/v1/media/asset-a/content", isSynthetic: false },
          ],
        } });
      }
      return originalFetch(input, init);
    });
    await act(async () => root.render(createElement(CreateWorkspace)));
    await waitUntil(() => Boolean(container.querySelector('[data-testid="create-step-preview"]')));

    const candidates = container.querySelector('[data-testid="create-preview-candidates"]');
    expect(candidates?.querySelector('img[src="/api/v1/media/asset-a/content"]')).not.toBeNull();
    expect(candidates?.querySelector('img[src="/api/v1/media/asset-b/content"]')).not.toBeNull();
    expect(container.textContent).not.toContain("Preview generation failed");
    expect(container.querySelector<HTMLButtonElement>('[data-testid="create-confirm-identity"]')?.disabled)
      .toBe(false);
    expect(vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
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
    // The sweeper settles an unknown outcome on its own; the user is told so, not sent to support.
    expect(container.textContent).toContain("marked failed automatically");
    expect(container.querySelector('a[href="/helpdesk"]')).toBeNull();
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

  it.each([false, true])("keeps newly typed appearance when current-draft validation returns late (next saved: %s)", async (saveBeforeValidation) => {
    const appearance = "Adult gardener with short brown hair, green eyes, wearing a sage green cardigan and jeans, standing on a sunny balcony.";
    const revision = "2026-10-02T00:00:00.000Z";
    const key = draftStorageKeyForScope("user:creator-1");
    window.localStorage.setItem(key, JSON.stringify({
      ...initialCharacterDraft(), draftId: "draft-1", draftUpdatedAt: revision,
      step: 1, name: "Avery", hair: "Short brown hair", body: "Average build",
      description: "Warm and direct", firstMessage: "Hello there",
    }));
    let finishValidation!: (response: Response) => void;
    const originalFetch = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input) === "/api/v1/character-drafts/current") {
        return new Promise<Response>(resolve => { finishValidation = resolve; });
      }
      if (String(input) === "/api/v1/character-drafts/draft-1" && init?.method === "PATCH") {
        return Response.json({ ok: true, data: { draft: { id: "draft-1", updatedAt: "2026-10-02T00:00:01.000Z" } } });
      }
      return originalFetch(input, init);
    });
    await act(async () => root.render(createElement(CreateWorkspace)));
    await waitUntil(() => Boolean(finishValidation) && Boolean(container.querySelector('[data-testid="create-step-appearance"]')));
    await changeField("Appearance", appearance);
    const next = async () => act(async () => [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.trim() === "Next")?.click());
    if (saveBeforeValidation) await next();
    await act(async () => finishValidation(Response.json({ ok: true, data: { draft: {
      id: "draft-1", updatedAt: revision, step: 1, name: "Avery", gender: "female", style: "realistic",
      appearance: { prompt: "" }, hair: { prompt: "Short brown hair" }, body: { type: "Average build" }, tags: [],
      advancedDetails: { age: 21, description: "Warm and direct", firstMessage: "Hello there" }, previewJobId: null,
    } } })));

    if (saveBeforeValidation) {
      expect(container.querySelector('[data-testid="create-step-soul"]')).not.toBeNull();
      expect(container.textContent).not.toContain("Load the latest saved draft");
      expect(JSON.parse(window.localStorage.getItem(key)!)).toMatchObject({ appearance, draftUpdatedAt: "2026-10-02T00:00:01.000Z", step: 2 });
    } else {
      expect(field("Appearance").value).toBe(appearance);
      await next();
    }
    const saved = vi.mocked(fetch).mock.calls.find(([input, init]) => String(input) === "/api/v1/character-drafts/draft-1" && init?.method === "PATCH");
    expect(JSON.parse(String(saved?.[1]?.body))).toMatchObject({ appearance: { prompt: appearance }, expectedUpdatedAt: revision });
  });

  it("starts fresh when the server no longer has the locally saved draft (it was saved as a character)", async () => {
    window.localStorage.setItem(draftStorageKeyForScope("user:creator-1"), JSON.stringify({
      ...initialCharacterDraft(), draftId: "draft-saved", step: 4, name: "Already saved", confirmedPreviewJobId: "preview-1",
    }));
    const originalFetch = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input) === "/api/v1/character-drafts/current") return Response.json({ ok: true, data: { draft: null, previewJob: null, asset: null } });
      return originalFetch(input, init);
    });
    await act(async () => root.render(createElement(CreateWorkspace)));
    await waitUntil(() => container.querySelector<HTMLInputElement>('input[placeholder="Nova Reyes"]')?.value === "");
    expect(container.textContent).not.toContain("Already saved");
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
        previewCandidates: [{ previewJobId: "saved-preview", assetId: "saved-asset", url: "/api/v1/media/saved-asset/content", isSynthetic: false }],
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

  it("marks required Soul fields and reports every missing one beside its field at once", async () => {
    window.localStorage.setItem(draftStorageKeyForScope("user:creator-1"), JSON.stringify({
      ...initialCharacterDraft(), draftId: "draft-1", step: 2, name: "Avery", description: "", firstMessage: "",
    }));
    await act(async () => root.render(createElement(CreateWorkspace)));
    await waitUntil(() => Boolean(container.querySelector('[data-testid="create-step-soul"]')));
    const promise = container.querySelector<HTMLTextAreaElement>("#create-field-promise")!;
    const firstMessage = container.querySelector<HTMLTextAreaElement>("#create-field-first-message")!;
    expect(promise.getAttribute("aria-required")).toBe("true");
    expect(firstMessage.getAttribute("aria-required")).toBe("true");
    expect(container.querySelector("#create-field-details")?.getAttribute("aria-required")).toBeNull();
    expect(promise.getAttribute("aria-invalid")).toBeNull();

    await act(async () => [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.trim() === "Next")?.click());
    expect(document.activeElement).toBe(promise);
    for (const [input, message] of [[promise, "Write the character promise."], [firstMessage, "Write the character's first message."]] as const) {
      expect(input.getAttribute("aria-invalid")).toBe("true");
      const described = container.querySelector(`#${input.getAttribute("aria-describedby")}`);
      expect(described?.textContent).toBe(message);
      // The message sits inside the field it is about, not in a distant status line.
      expect(input.closest("label")?.contains(described!)).toBe(true);
    }
    expect(vi.mocked(fetch).mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(false);

    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(promise, "Warm and direct");
      promise.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(promise.getAttribute("aria-invalid")).toBeNull();
    expect(firstMessage.getAttribute("aria-invalid")).toBe("true");
  });

  it("saves catalog suggestions and custom details in the same Soul and restores both", async () => {
    const key = draftStorageKeyForScope("user:creator-1");
    window.localStorage.setItem(key, JSON.stringify({
      ...initialCharacterDraft(), draftId: "draft-1", step: 2, name: "Avery",
      description: "Warm and direct", firstMessage: "Hello there",
      detailsMarkdown: "## Background\nAn observatory keeper on a remote island.",
    }));
    await act(async () => root.render(createElement(CreateWorkspace)));
    await waitUntil(() => Boolean(container.querySelector('[data-testid="create-step-soul"]')));
    for (const [label, choice] of [
      ["Personality", "Quiet and perceptive"],
      ["Occupation", "Astronomer"],
      ["Relationship", "Allies with a shared mission"],
    ]) {
      const list = document.getElementById(field(label!).getAttribute("list")!);
      expect([...list!.querySelectorAll("option")].some(option => option.value === choice)).toBe(true);
      // Real typing reads the controlled value back between keystrokes.
      for (const character of choice!) {
        await changeField(label!, field(label!).value + character);
      }
    }
    await changeField("Occupation", "Keeper of a lunar observatory");
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find(button => button.textContent?.trim() === "Next")?.click());
    const saved = vi.mocked(fetch).mock.calls.find(([input, init]) =>
      String(input) === "/api/v1/character-drafts/draft-1" && init?.method === "PATCH");
    const markdown = JSON.parse(String(saved?.[1]?.body)).advancedDetails.detailsMarkdown;
    expect(markdown).toContain("## Background\nAn observatory keeper on a remote island.");
    expect(markdown).toContain("## Personality\nQuiet and perceptive");
    expect(markdown).toContain("## Occupation\nKeeper of a lunar observatory");
    expect(markdown).toContain("## Relationship\nAllies with a shared mission");
    expect(markdown).not.toContain("Astronomer");
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find(button => button.textContent?.trim() === "Back")?.click());
    await act(async () => root.render(null));
    await act(async () => root.render(createElement(CreateWorkspace)));
    await waitUntil(() => Boolean(container.querySelector('[data-testid="create-step-soul"]')));
    expect(field("Personality").value).toBe("Quiet and perceptive");
    expect(field("Occupation").value).toBe("Keeper of a lunar observatory");
    expect(field("Relationship").value).toBe("Allies with a shared mission");
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

  it("uses the confirmed preview revision when saving the next step", async () => {
    const key = draftStorageKeyForScope("user:creator-1");
    const initialRevision = "2026-10-01T00:00:00.000Z";
    const confirmationRevision = "2026-10-01T00:00:01.000Z";
    const saved = JSON.parse(window.localStorage.getItem(key)!);
    window.localStorage.setItem(key, JSON.stringify({ ...saved, draftUpdatedAt: initialRevision }));
    const server = { id: "draft-1", updatedAt: initialRevision, step: 3, name: "Avery", gender: "female", style: "realistic", appearance: {}, hair: {}, body: {}, tags: [], advancedDetails: { age: 21, description: "Warm and direct", firstMessage: "Hello there" }, previewJobId: null };
    const originalFetch = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input) === "/api/v1/character-drafts/current") return Response.json({ ok: true, data: { draft: server } });
      if (String(input) === "/api/v1/character-drafts/draft-1" && init?.method === "PATCH") {
        expect(JSON.parse(String(init.body)).expectedUpdatedAt).toBe(confirmationRevision);
        return Response.json({ ok: true, data: { draft: { ...server, step: 4, previewJobId: "preview-1", updatedAt: "2026-10-01T00:00:02.000Z" } } });
      }
      return originalFetch(input, init);
    });
    await act(async () => root.render(createElement(CreateWorkspace)));
    await waitUntil(() => Boolean(container.querySelector('[data-testid="create-confirm-identity"]')));
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="create-confirm-identity"]')!.click());
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls.find(([input]) => String(input).endsWith("/preview-anchor"))![1]?.body)).expectedUpdatedAt).toBe(initialRevision);
    await act(async () => releaseConfirmation!(Response.json({ ok: true, data: { draft: { ...server, previewJobId: "preview-1", updatedAt: confirmationRevision } } })));
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="create-next"]')!.click());
    await waitUntil(() => Boolean(container.querySelector('[data-testid="create-step-publish"]')));
    expect(container.querySelector('[data-testid="create-draft-conflict"]')).toBeNull();
  });

  it("keeps unsaved inputs on a stale-tab save and loads the latest saved draft only on request", async () => {
    const key = draftStorageKeyForScope("user:creator-1");
    const oldRevision = "2026-10-01T00:00:00.000Z";
    let server = { id: "draft-1", updatedAt: oldRevision, step: 0, name: "Original name", gender: "female", style: "realistic", appearance: {}, hair: {}, body: {}, tags: [], advancedDetails: { age: 21, description: "Warm and direct" }, previewJobId: null };
    window.localStorage.setItem(key, JSON.stringify({ ...initialCharacterDraft(), draftId: "draft-1", draftUpdatedAt: oldRevision, name: "Original name", description: "Warm and direct" }));
    const originalFetch = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input) === "/api/v1/character-drafts/current") return Response.json({ ok: true, data: { draft: server } });
      if (String(input) === "/api/v1/character-drafts/draft-1" && init?.method === "PATCH") {
        const body = JSON.parse(String(init.body));
        if (body.expectedUpdatedAt && body.expectedUpdatedAt !== server.updatedAt) return Response.json({ ok: false, error: { code: "conflict", message: "This draft changed in another tab. Load the latest saved draft before saving. Your current inputs have been kept.", details: { blocker: "version_mismatch" } } }, { status: 409 });
        server = { ...server, ...body, updatedAt: "2026-10-01T00:00:02.000Z" };
        return Response.json({ ok: true, data: { draft: server } });
      }
      return originalFetch(input, init);
    });
    await act(async () => root.render(createElement(CreateWorkspace)));
    await waitUntil(() => Boolean(container.querySelector('[data-testid="create-next"]')));
    server = { ...server, name: "New name from another tab", updatedAt: "2026-10-01T00:00:01.000Z" };
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="create-next"]')!.click());
    await waitUntil(() => Boolean(container.querySelector('[data-testid="create-status"]') || container.textContent?.includes("A free-text summary of how they look.")));
    expect(server.name).toBe("New name from another tab");
    expect(container.querySelector<HTMLInputElement>('input[placeholder="Nova Reyes"]')!.value).toBe("Original name");
    expect(container.querySelector('[data-testid="create-draft-conflict"]')?.textContent).toContain("current inputs");
    const reload = [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.trim() === "Load latest saved draft");
    expect(reload).toBeDefined();
    await act(async () => reload!.click());
    await waitUntil(() => container.querySelector<HTMLInputElement>('input[placeholder="Nova Reyes"]')?.value === "New name from another tab");
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="create-next"]')!.click());
    await waitUntil(() => Boolean(container.querySelector('[data-testid="create-step-appearance"]')));
    expect(JSON.parse(window.localStorage.getItem(key)!).draftUpdatedAt).toBe(server.updatedAt);
  });

  it.each(["", "2026-10-01T00:00:00.000Z"])("does not adopt the latest revision for a conflicting local draft on refresh (saved revision=%s)", async (draftUpdatedAt) => {
    const key = draftStorageKeyForScope("user:creator-1");
    window.localStorage.setItem(key, JSON.stringify({ ...initialCharacterDraft(), draftId: "draft-1", draftUpdatedAt, name: "Unsaved local name" }));
    const originalFetch = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input) === "/api/v1/character-drafts/current") return Response.json({ ok: true, data: { draft: {
        id: "draft-1", updatedAt: "2026-10-01T00:00:01.000Z", step: 0, name: "Latest saved name", gender: "female", style: "realistic", appearance: {}, hair: {}, body: {}, tags: [], advancedDetails: { age: 21 }, previewJobId: null,
      } } });
      return originalFetch(input, init);
    });
    await act(async () => root.render(createElement(CreateWorkspace)));
    await waitUntil(() => Boolean(container.querySelector('[data-testid="create-next"]')));
    expect(container.querySelector('[data-testid="create-draft-conflict"]')).not.toBeNull();
    expect(container.querySelector<HTMLInputElement>('input[placeholder="Nova Reyes"]')!.value).toBe("Unsaved local name");
    expect(vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(0);
  });

  async function waitUntil(predicate: () => boolean) {
    const deadline = Date.now() + 2_000;
    while (!predicate()) {
      if (Date.now() >= deadline) throw new Error(`Create workspace did not load: ${container.textContent}`);
      await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    }
  }
});

describe("CreateWorkspace quick start", () => {
  let container: HTMLDivElement;
  let root: Root;
  let quickStart: () => Response;
  const storageKey = draftStorageKeyForScope("user:creator-1");

  beforeEach(() => {
    const entries = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => entries.get(key) ?? null,
      setItem: (key: string, value: string) => entries.set(key, value),
      removeItem: (key: string) => entries.delete(key),
      clear: () => entries.clear(),
    });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/v1/me") {
        return Response.json({ ok: true, data: { user: { id: "creator-1" }, anonymousId: null } });
      }
      if (url === "/api/v1/character-drafts/quick-start") return quickStart();
      if (url === "/api/v1/character-templates") return Response.json({ ok: true, data: { items: [] } });
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

  async function submitBrief(brief: string) {
    await act(async () => root.render(createElement(CreateWorkspace)));
    await waitUntil(() => Boolean(container.querySelector('[data-testid="create-quick-start"] input')));
    const input = container.querySelector<HTMLInputElement>('[data-testid="create-quick-start"] input')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, brief);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="create-quick-start"] button')!.click());
  }

  function nameInput() {
    return container.querySelector<HTMLInputElement>("#create-field-name")!;
  }

  it("prefills the wizard through the template path and leaves every field editable", async () => {
    quickStart = () => Response.json({ ok: true, data: { draft: {
      name: "Mira", age: 24, gender: "female", style: "anime", hair: "Short auburn curls",
      description: "A café illustrator.", firstMessage: "Back again?",
      occupation: "Illustrator", relationship: "Friend",
    } } });
    await submitBrief("A café illustrator");
    await waitUntil(() => container.querySelector('[data-testid="create-status"]')?.textContent?.includes("Prefilled") === true);
    expect(nameInput().value).toBe("Mira");
    const posted = vi.mocked(fetch).mock.calls.find(([input]) => String(input) === "/api/v1/character-drafts/quick-start");
    expect(JSON.parse(String(posted?.[1]?.body))).toEqual({ brief: "A café illustrator" });
    const saved = JSON.parse(window.localStorage.getItem(storageKey)!);
    expect(saved).toMatchObject({ step: 0, age: 24, style: "anime", hair: "Short auburn curls", firstMessage: "Back again?" });
    expect(saved.detailsMarkdown).toBe("## Occupation\nIllustrator\n\n## Relationship\nFriend");
    // Nothing was created: the only write was the quick-start request itself.
    expect(vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method && init.method !== "GET")).toHaveLength(1);
  });

  it("shows a retryable failure and keeps the draft untouched", async () => {
    quickStart = () => Response.json(
      { ok: false, error: { code: "unavailable", message: "Quick Start could not reach the character model. Try again." } },
      { status: 503 },
    );
    await submitBrief("A café illustrator");
    await waitUntil(() => Boolean(container.querySelector('[data-testid="create-quick-start"] [role="alert"]')));
    expect(container.querySelector('[data-testid="create-quick-start"] [role="alert"]')?.textContent).toBe(
      "Quick Start could not reach the character model. Try again.",
    );
    expect(nameInput().value).toBe("");
    expect(container.querySelector<HTMLButtonElement>('[data-testid="create-quick-start"] button')?.disabled).toBe(false);
  });

  it("turns an HTML outage page into a plain retry message, not a parser error or a sign-in prompt", async () => {
    quickStart = () => new Response("<!doctype html><title>502</title>", { status: 502, headers: { "content-type": "text/html" } });
    await submitBrief("A café illustrator");
    await waitUntil(() => Boolean(container.querySelector('[data-testid="create-quick-start"] [role="alert"]')));
    expect(container.querySelector('[data-testid="create-quick-start"] [role="alert"]')?.textContent).toBe(
      "Something went wrong. Check your connection and try again.",
    );
  });

  it("caps the Name field at the server's 80 characters", async () => {
    await act(async () => root.render(createElement(CreateWorkspace)));
    await waitUntil(() => Boolean(container.querySelector("#create-field-name")));
    expect(nameInput().maxLength).toBe(80);
  });

  async function waitUntil(predicate: () => boolean) {
    const deadline = Date.now() + 2_000;
    while (!predicate()) {
      if (Date.now() >= deadline) throw new Error(`Create workspace did not load: ${container.textContent}`);
      await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    }
  }
});
