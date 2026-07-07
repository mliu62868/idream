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

// 2x2 PNG (checkerboard black/white) — the brief's original 1x1 fixture had a
// truncated/corrupt IDAT chunk (bad CRC) and, even fixed, a true 1x1 pixel is
// uniform by construction so it would always trip assertGeneratedImageSanity's
// degenerate-image check. Use a valid, non-degenerate 2x2 image instead so the
// happy-path test actually exercises the sanity check without tripping it.
const PNG = Uint8Array.from(atob(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAE0lEQVR4nGNgYGD4//8/GDMwAAAp5AX71ZPZmwAAAABJRU5ErkJggg=="
), (c) => c.charCodeAt(0));

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
});
