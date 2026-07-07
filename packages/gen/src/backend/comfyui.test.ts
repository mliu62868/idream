import { describe, it, expect, vi, beforeEach } from "vitest";
import { ComfyUIBackend } from "./comfyui";
import { workflowDescriptorSchema } from "./workflow";

const descriptor = workflowDescriptorSchema.parse({
  workflowKey: "t2i", modelId: "redcraft-krea2-comfyui", backendKind: "comfyui",
  version: 1, capabilities: ["textToImage"],
  apiPrompt: { "9": { class_type: "SaveImage", inputs: {} },
               "6": { class_type: "CLIPTextEncode", inputs: { text: "" } } },
  inputs: [{ key: "prompt", type: "text", target: { nodeId: "6", field: "text" } }],
});

// edit-style descriptor carrying an image-type slot (LoadImage node), shared by the
// reference-image upload tests below.
const editDescriptor = workflowDescriptorSchema.parse({
  workflowKey: "edit-wf", modelId: "edit-m", backendKind: "comfyui", version: 1,
  capabilities: ["img2img", "edit", "referenceImages"],
  apiPrompt: {
    "8": { class_type: "LoadImage", inputs: { image: "" } },
    "3": { class_type: "TextEncodeQwenImageEditPlus", inputs: { prompt: "" } },
    "9": { class_type: "SaveImage", inputs: {} },
  },
  inputs: [
    { key: "edit_prompt", type: "text", target: { nodeId: "3", field: "prompt" } },
    { key: "source_image", type: "image", target: { nodeId: "8", field: "image" } },
  ],
});

// 2x2 PNG (checkerboard black/white) — the brief's original 1x1 fixture had a
// truncated/corrupt IDAT chunk (bad CRC) and, even fixed, a true 1x1 pixel is
// uniform by construction so it would always trip assertGeneratedImageSanity's
// degenerate-image check. Use a valid, non-degenerate 2x2 image instead so the
// happy-path test actually exercises the sanity check without tripping it.
// PNG_B64 is also reused as the b64Json payload for reference-image upload tests.
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAE0lEQVR4nGNgYGD4//8/GDMwAAAp5AX71ZPZmwAAAABJRU5ErkJggg==";
const PNG = Uint8Array.from(atob(PNG_B64), (c) => c.charCodeAt(0));

function mockFetch(seq: Array<() => Response>) {
  let i = 0;
  return vi.fn(async (..._args: Parameters<typeof fetch>) => seq[Math.min(i++, seq.length - 1)]());
}

describe("ComfyUIBackend", () => {
  beforeEach(() => vi.restoreAllMocks());
  it("submits prompt then polls history and fetches image", async () => {
    const g = mockFetch([
      () => new Response(JSON.stringify({ prompt_id: "p1" }), { status: 200 }),
      () => new Response(JSON.stringify({ p1: { status: { completed: true },
        outputs: { "9": { images: [{ filename: "a.png", subfolder: "", type: "output" }] } } } }), { status: 200 }),
      () => new Response(PNG, { status: 200, headers: { "content-type": "image/png" } }),
    ]);
    vi.stubGlobal("fetch", g);
    const backend = new ComfyUIBackend({ apiUrl: "http://x" });
    const handle = await backend.submit({ descriptor, slots: { prompt: "cat" }, timeoutMs: 5000 });
    expect(handle.id).toBe("p1");
    const result = await backend.poll(handle);
    expect(result.assets).toHaveLength(1);
    expect(result.assets[0].body.byteLength).toBeGreaterThan(0);
    // submitted body carried the bound slot
    const submitBody = JSON.parse((g.mock.calls[0][1] as RequestInit).body as string);
    expect(submitBody.prompt["6"].inputs.text).toBe("cat");
  });
  it("throws when prompt is rejected (no prompt_id)", async () => {
    vi.stubGlobal("fetch", mockFetch([() => new Response(JSON.stringify({ node_errors: { "6": "bad" } }), { status: 200 })]));
    const backend = new ComfyUIBackend({ apiUrl: "http://x" });
    await expect(backend.submit({ descriptor, slots: { prompt: "cat" }, timeoutMs: 5000 })).rejects.toThrow();
  });
  it("uploads reference image and binds filename into image slot", async () => {
    const g = mockFetch([
      () => new Response(JSON.stringify({ name: "up.png", subfolder: "", type: "input" }), { status: 200 }), // upload
      () => new Response(JSON.stringify({ prompt_id: "p9" }), { status: 200 }), // prompt
    ]);
    vi.stubGlobal("fetch", g);
    const backend = new ComfyUIBackend({ apiUrl: "http://x" });
    await backend.submit({
      descriptor: editDescriptor,
      slots: { edit_prompt: "red dress" },
      referenceImages: [{ assetId: "a1", role: "source_image", b64Json: PNG_B64 }],
      timeoutMs: 5000,
    });
    // upload call is multipart
    const uploadCall = g.mock.calls[0];
    expect(String(uploadCall[0])).toContain("/upload/image");
    expect((uploadCall[1] as RequestInit).body).toBeInstanceOf(FormData);
    // prompt body's LoadImage slot is bound to the uploaded name
    const promptBody = JSON.parse((g.mock.calls[1][1] as RequestInit).body as string);
    expect(promptBody.prompt["8"].inputs.image).toBe("up.png");
  });
  it("throws when a required image slot has no reference image", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const backend = new ComfyUIBackend({ apiUrl: "http://x" });
    await expect(
      backend.submit({
        descriptor: editDescriptor,
        slots: { edit_prompt: "red dress" },
        referenceImages: [],
        timeoutMs: 5000,
      }),
    ).rejects.toThrow(/source_image/);
  });
  it("fetches reference image bytes from url when b64Json is absent", async () => {
    const g = mockFetch([
      () => new Response(PNG, { status: 200, headers: { "content-type": "image/png" } }), // url fetch
      () => new Response(JSON.stringify({ name: "url.png", subfolder: "in", type: "input" }), { status: 200 }), // upload
      () => new Response(JSON.stringify({ prompt_id: "p10" }), { status: 200 }), // prompt
    ]);
    vi.stubGlobal("fetch", g);
    const backend = new ComfyUIBackend({ apiUrl: "http://x" });
    await backend.submit({
      descriptor: editDescriptor,
      slots: { edit_prompt: "blue dress" },
      referenceImages: [{ assetId: "a2", role: "source_image", url: "http://example.com/ref.png" }],
      timeoutMs: 5000,
    });
    // url was fetched (first call) before upload (second) and prompt (third)
    expect(String(g.mock.calls[0][0])).toBe("http://example.com/ref.png");
    const promptBody = JSON.parse((g.mock.calls[2][1] as RequestInit).body as string);
    expect(promptBody.prompt["8"].inputs.image).toBe("in/url.png");
  });
});
