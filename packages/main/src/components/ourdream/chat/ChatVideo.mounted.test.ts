// @vitest-environment happy-dom
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatVideoComposer } from "./ChatVideoComposer";
import { ChatVideoAttachmentCard } from "./ChatVideoAttachmentCard";

vi.mock("next/link", () => ({ default: ({ href, children, ...props }: ComponentProps<"a">) => createElement("a", { href: String(href), ...props }, children) }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const source = { sessionId: "speaker-session", characterId: "speaker", turnId: "source-turn", attempt: 3, mediaAssetId: "source-image", url: "/source.png" };
const context = {
  token: "original-image-context", identityMode: "character", characterId: "speaker", characterName: "Mira",
  source: { kind: "chat", sessionId: source.sessionId, turnId: source.turnId, attempt: source.attempt, mediaAssetId: source.mediaAssetId }, returnHref: "/chat/speaker-session", sourceLabel: "Mira", prompt: "Mira by the blue window", scene: null,
  sourceMedia: { id: source.mediaAssetId, url: source.url, thumbnailUrl: source.url },
  pins: { characterContentVersionId: "content", characterReleaseId: "release", releaseSnapshotHash: "a".repeat(64), visualProfileId: "visual", visualProfileVersion: 1, referenceSetRevisionId: "references" },
};
const pricing = { ruleId: "video-price", ruleKey: "video", version: 1, effectiveFrom: null, fingerprint: "b".repeat(64) };
const quote = { mode: "video", profileId: "video-model", profileVersion: 1, routeFingerprint: "a".repeat(64), pricing, orientations: ["2:3"], defaultOrientation: "2:3", maxCount: 1, costs: [{ outputCount: 1, costDreamcoins: 40 }], balance: 80, identityLocked: true, video: { durationSeconds: 6, width: 720, height: 1080, audio: "generated" } };
const authority = { profileId: quote.profileId, profileVersion: quote.profileVersion, routeFingerprint: quote.routeFingerprint, pricingFingerprint: pricing.fingerprint, outputCount: 1, costDreamcoins: 40 };
const retryQuote = { mode: "video", generationJobId: "video-job", profileId: quote.profileId, profileVersion: 1, routeFingerprint: quote.routeFingerprint, pricing, outputCount: 1, costDreamcoins: 40, balance: 80 };
const json = (data: unknown) => Response.json({ ok: true, data });

describe("Chat video confirmation and history", () => {
  let root: Root;
  let container: HTMLDivElement;
  let requests: Array<{ url: string; options?: RequestInit }>;
  beforeEach(() => {
    requests = [];
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, options?: RequestInit) => {
      const url = String(input); requests.push({ url, options });
      if (url.includes("/generation/context?")) return json({ context });
      if (url.endsWith("/retry/quote")) return json({ quote: retryQuote });
      if (url.endsWith("/video/quote")) return json({ quote });
      if (url.endsWith("/video")) return json({ capability: { enabled: true, entitled: true } });
      if (url.endsWith("/download")) return json({ url: "/signed/video-asset.mp4" });
      throw new Error(`Unexpected fetch: ${url}`);
    }));
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  async function render(node: ReturnType<typeof createElement>) { await act(async () => { root.render(node); await new Promise(resolve => setTimeout(resolve, 0)); }); }
  async function click(text: string) {
    const button = [...container.querySelectorAll("button")].find(item => item.textContent?.includes(text));
    expect(button, text).toBeDefined();
    await act(async () => { button!.click(); await new Promise(resolve => setTimeout(resolve, 0)); });
  }

  it("prices the exact selected speaker image and waits for a separate paid confirmation", async () => {
    const submit = vi.fn(async () => true); const close = vi.fn();
    await render(createElement(ChatVideoComposer, { sources: [source], initialPrompt: "Slowly turn toward the window.", ownerScope: "user:viewer", onClose: close, onSubmit: submit }));
    await click("Check video price");
    expect(submit).not.toHaveBeenCalled();
    expect(container.textContent).toContain("6-second video · 40 Dreamcoins");
    const contextRequest = requests.find(item => item.url.includes("/generation/context?"))!;
    const params = new URL(contextRequest.url, "http://localhost").searchParams;
    expect(Object.fromEntries(params)).toEqual({ kind: "chat", sessionId: "speaker-session", turnId: "source-turn", attempt: "3", mediaAssetId: "source-image" });
    expect(new Headers(contextRequest.options?.headers).get("x-idream-viewer-scope")).toBe("user:viewer");
    await click("Confirm and generate video");
    expect(submit).toHaveBeenCalledExactlyOnceWith({ sessionId: "speaker-session", body: { generationContextToken: context.token, prompt: "Slowly turn toward the window.", quoteAuthority: authority } });
    expect(close).toHaveBeenCalledOnce();
  });

  it("invalidates the confirmed price when the user chooses another source image", async () => {
    const submit = vi.fn(async () => true);
    await render(createElement(ChatVideoComposer, { sources: [source, { ...source, mediaAssetId: "other-image", turnId: "other-turn", url: "/other.png" }], initialPrompt: "Look at the camera.", ownerScope: "user:viewer", onClose: vi.fn(), onSubmit: submit }));
    await click("Check video price");
    const select = container.querySelector("select")!;
    await act(async () => { select.value = "other-image"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(container.textContent).not.toContain("Confirm and generate video");
    expect(container.querySelector("img")?.getAttribute("src")).toBe("/other.png");
    expect(submit).not.toHaveBeenCalled();
  });

  it("keeps a delivered video playable without checking a current feature or plan", async () => {
    await render(createElement(ChatVideoAttachmentCard, { attachment: { id: "video-attachment", kind: "generated_video", status: "completed", generationJobId: "video-job", mediaAssetId: "video-asset", mediaUrl: "/video.mp4", thumbnailUrl: "/poster.png" }, ownerScope: null, retryPending: false, onRetry: vi.fn(), onCancelled: vi.fn() }));
    expect(container.querySelector("video")?.getAttribute("src")).toBe("/video.mp4");
    expect(container.querySelector("video")?.controls).toBe(true);
    // The download endpoint answers with the file URL; a plain link to it would open JSON.
    expect(container.querySelector('a[href*="/download"]')).toBeNull();
    expect(requests).toHaveLength(0);
    const assign = vi.spyOn(window.location, "assign").mockImplementation(() => {});
    await click("Download video");
    expect(requests.map(item => item.url)).toEqual(["/api/v1/media/video-asset/download"]);
    expect(assign).toHaveBeenCalledExactlyOnceWith("/signed/video-asset.mp4");
  });

  it("does not start a video retry until its quoted price is confirmed", async () => {
    const retry = vi.fn(async () => {});
    await render(createElement(ChatVideoAttachmentCard, { attachment: { id: "video-attachment", kind: "generated_video", status: "failed", generationJobId: "video-job" }, ownerScope: "user:viewer", retryPending: false, onRetry: retry, onCancelled: vi.fn() }));
    await click("Check video retry price");
    expect(retry).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Retry this video · 40 Dreamcoins");
    await click("Confirm video retry");
    expect(retry).toHaveBeenCalledExactlyOnceWith(authority);
  });

  it("keeps the active attachment intact when processing has already started", async () => {
    const cancelled = vi.fn(async () => {});
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: false, error: { code: "conflict", message: "This video has already entered processing." } }, { status: 409 })));
    await render(createElement(ChatVideoAttachmentCard, { attachment: { id: "video-attachment", kind: "generated_video", status: "accepted", generationJobId: "video-job" }, ownerScope: "user:viewer", retryPending: false, onRetry: vi.fn(), onCancelled: cancelled }));
    await click("Cancel before processing");
    expect(cancelled).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Generating video");
    expect(container.textContent).toContain("already entered processing");
    expect(container.textContent).not.toContain("Video cancelled");
  });
});
