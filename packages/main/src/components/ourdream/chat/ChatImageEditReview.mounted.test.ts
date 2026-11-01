// @vitest-environment happy-dom
import { createHash, webcrypto } from "node:crypto";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatImageEditReviewCard } from "./ChatImageEditReviewCard";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const sourceBytes = new Uint8Array([1, 2, 3]);
const sourceHash = createHash("sha256").update(sourceBytes).digest("hex");
const quote = { profileId: "recolor", profileVersion: 1, routeFingerprint: "a".repeat(64), pricingFingerprint: "b".repeat(64), outputCount: 1, costDreamcoins: 0 };
const review = { attachmentId: "attachment", turnId: "turn", attempt: 1, status: "awaiting_confirmation", draftFingerprint: "c".repeat(64), instruction: "Change only the cup to red.", target: "cup", source: { mediaAssetId: "source", snapshotId: "snapshot", sha256: sourceHash, width: 2, height: 2, contentType: "image/png", url: "/api/source" }, quotes: { recolor: quote, generate: { ...quote, profileId: "generate", costDreamcoins: 8 } }, limits: { maskMaxBytes: 524288, maxPixels: 4194304 } };
const json = (data: unknown) => Response.json({ ok: true, data });

describe("confirmed image edit UI", () => {
  let root: Root;
  let container: HTMLDivElement;
  let requests: Array<{ url: string; options?: RequestInit }>;
  let fetcher: ReturnType<typeof vi.fn<(input: RequestInfo | URL, options?: RequestInit) => Promise<Response>>>;
  let changed: ReturnType<typeof vi.fn<() => Promise<void>>>;
  let cursorArc: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    const storage = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => { storage.set(key, value); }, removeItem: (key: string) => { storage.delete(key); } });
    requests = []; changed = vi.fn(async () => {}); cursorArc = vi.fn();
    vi.stubGlobal("crypto", webcrypto);
    vi.stubGlobal("ImageData", class { constructor(public data: Uint8ClampedArray, public width: number, public height: number) {} });
    vi.stubGlobal("Image", class {
      naturalWidth = 2; naturalHeight = 2; onload?: () => void; onerror?: () => void; currentSource = "";
      set src(value: string) { this.currentSource = value; queueMicrotask(() => this.onload?.()); }
    });
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:source");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const states = new WeakMap<HTMLCanvasElement, { image?: { currentSource: string }; data?: ImageData }>();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement) {
      const state = states.get(this) ?? {}; states.set(this, state);
      return {
        drawImage(image: { currentSource: string }) { state.image = image; },
        getImageData() {
          const src = state.image?.currentSource;
          return new ImageData(src?.startsWith("data:") ? new Uint8ClampedArray(Buffer.from(src.split(",")[1]!, "base64")) : new Uint8ClampedArray([0, 100, 0, 255, 0, 100, 0, 255, 200, 150, 120, 255, 200, 150, 120, 255]), 2, 2);
        },
        putImageData(data: ImageData) { state.data = data; },
        beginPath() {}, arc: cursorArc, moveTo() {}, lineTo() {}, stroke() {},
      } as unknown as CanvasRenderingContext2D;
    });
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockImplementation(function (this: HTMLCanvasElement) {
      return `data:image/png;base64,${Buffer.from(states.get(this)!.data!.data).toString("base64")}`;
    });
    fetcher = vi.fn(async (input, options) => {
      const url = String(input); requests.push({ url, options });
      if (url.endsWith("/edit-review")) return json({ review });
      if (url === "/api/source") return new Response(sourceBytes);
      if (url.endsWith("/confirm")) return json({ attachmentId: "attachment", generationJobId: "job" });
      if (url.endsWith("/cancel")) return json({ attachmentId: "attachment", status: "cancelled" });
      throw new Error(`Unexpected request: ${url}`);
    });
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); document.body.style.overflow = ""; vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  const tick = () => new Promise(resolve => setTimeout(resolve, 10));
  async function render(ownerScope = "user:one") {
    await act(async () => { root.render(createElement(ChatImageEditReviewCard, { key: ownerScope, attachmentId: "attachment", ownerScope, fetchForViewer: fetcher, onChanged: changed })); await tick(); });
  }
  function button(label: string): HTMLButtonElement {
    const found = [...document.querySelectorAll("button")].find(item => item.textContent?.includes(label));
    expect(found, label).toBeDefined(); return found!;
  }
  async function click(label: string) { await act(async () => { button(label).click(); await tick(); }); }
  async function open() { await render(); await click("Review edit area"); await act(tick); }
  async function selectAreaAndColor() {
    await act(async () => {
      const canvas = document.querySelector("canvas")!;
      canvas.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
      (document.querySelector('input[type="radio"]') as HTMLInputElement).click(); await tick();
    });
  }

  it("waits for an explicit region, operation, and confirmation before dispatch", async () => {
    await open();
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(button("Confirm edit").disabled).toBe(true);
    expect(requests.every(request => !request.options?.method)).toBe(true);
    await selectAreaAndColor();
    expect(button("Confirm edit · 0 coins").disabled).toBe(false);
    expect(requests.some(request => request.options?.method === "POST")).toBe(false);
    await click("Confirm edit");
    const confirmation = requests.filter(request => request.url.endsWith("/confirm"));
    expect(confirmation).toHaveLength(1);
    expect(JSON.parse(confirmation[0]!.options!.body as string)).toMatchObject({ attempt: 1, sourceSha256: sourceHash, operation: { kind: "recolor", color: "#e03030" }, quoteAuthority: quote });
    expect(new Headers(confirmation[0]!.options!.headers).get("x-idream-viewer-scope")).toBe("user:one");
    expect(changed).toHaveBeenCalledOnce();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("restores an interrupted confirmation without resubmitting until the user checks its exact key and body", async () => {
    const original = fetcher.getMockImplementation()!;
    let confirmationCount = 0;
    fetcher.mockImplementation(async (input, options) => {
      if (String(input).endsWith("/confirm") && ++confirmationCount === 1) {
        requests.push({ url: String(input), options }); throw new Error("Connection lost");
      }
      return original(input, options);
    });
    await open(); await selectAreaAndColor(); await click("Confirm edit");
    expect(button("Paint").disabled).toBe(true);
    expect(button("Cancel edit").disabled).toBe(true);
    await act(async () => { document.querySelector<HTMLButtonElement>('[aria-label="Close edit review"]')!.click(); await tick(); });
    await click("Review edit area"); await act(tick);
    expect(requests.filter(request => request.url.endsWith("/confirm"))).toHaveLength(1);
    await click("Check same request");
    const confirmations = requests.filter(request => request.url.endsWith("/confirm"));
    expect(confirmations).toHaveLength(2);
    expect(confirmations[1]!.options!.body).toBe(confirmations[0]!.options!.body);
    expect(new Headers(confirmations[1]!.options!.headers).get("Idempotency-Key")).toBe(new Headers(confirmations[0]!.options!.headers).get("Idempotency-Key"));
  });

  it("cancels an unpaid draft without confirming or creating an image", async () => {
    await open(); await click("Cancel edit");
    expect(requests.filter(request => request.options?.method === "POST").map(request => request.url)).toEqual(["/api/v1/chat/attachments/attachment/edit-review/cancel"]);
    expect(changed).toHaveBeenCalledOnce();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("does not show another owner's selection and revokes the open private editor on owner changes", async () => {
    await open(); await selectAreaAndColor();
    expect(document.body.textContent).toContain("100.0% selected");
    await render("user:two");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await click("Review edit area"); await act(tick);
    expect(document.body.textContent).toContain("0.0% selected");
    expect(button("Confirm edit").disabled).toBe(true);
    expect(requests.some(request => request.options?.method === "POST")).toBe(false);
  });

  it("rejects an image whose bytes do not match the frozen review source", async () => {
    const original = fetcher.getMockImplementation()!;
    fetcher.mockImplementation((input, options) => String(input) === "/api/source" ? Promise.resolve(new Response(new Uint8Array([9, 9, 9]))) : original(input, options));
    await open();
    expect(document.body.textContent).toContain("The original image changed");
    expect(document.querySelector("canvas")).toBeNull();
    expect(button("Confirm edit").disabled).toBe(true);
  });

  it("does not dispatch when the browser cannot retain the confirmation for recovery", async () => {
    await open(); await selectAreaAndColor();
    vi.spyOn(window.localStorage, "setItem").mockImplementation(() => { throw new Error("Quota exceeded"); });
    await click("Confirm edit");
    expect(document.body.textContent).toContain("Confirmation was not sent");
    expect(requests.some(request => request.url.endsWith("/confirm"))).toBe(false);
  });

  it("lets the owner cancel a draft after its source becomes unavailable", async () => {
    const original = fetcher.getMockImplementation()!;
    fetcher.mockImplementation((input, options) => String(input) === "/api/source" ? Promise.resolve(Response.json({ error: { message: "Source removed" } }, { status: 410 })) : original(input, options));
    await open();
    expect(document.body.textContent).toContain("original image is no longer available");
    expect(button("Confirm edit").disabled).toBe(true);
    expect(button("Cancel edit").disabled).toBe(false);
    await click("Cancel edit");
    expect(requests.filter(request => request.options?.method === "POST").map(request => request.url)).toEqual(["/api/v1/chat/attachments/attachment/edit-review/cancel"]);
    expect(changed).toHaveBeenCalledOnce();
  });

  it("shows the keyboard sampling position when selecting similar colors", async () => {
    await open(); await click("Similar color");
    cursorArc.mockClear();
    await act(async () => {
      const canvas = document.querySelector("canvas")!; canvas.focus();
      canvas.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })); await tick();
    });
    expect(cursorArc.mock.calls.some(call => call[0] === 0 && call[1] === 1)).toBe(true);
    expect(requests.some(request => request.options?.method === "POST")).toBe(false);
  });
});
