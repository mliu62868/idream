import { describe, it, expect, vi, beforeEach } from "vitest";
import { ComfyUIBackend } from "./comfyui";
import { workflowDescriptorSchema } from "./workflow";

const descriptor = workflowDescriptorSchema.parse({
  workflowKey: "t2i", modelId: "redcraft-krea2-comfyui", backendKind: "comfyui",
  comfyWorkflow: { id: "11111111-1111-4111-8111-111111111111", name: "iDream Test T2I" },
  version: 1, capabilities: ["textToImage"],
  apiPrompt: { "9": { class_type: "SaveImage", inputs: {} },
               "6": { class_type: "CLIPTextEncode", inputs: { text: "" } } },
  inputs: [{ key: "prompt", type: "text", target: { nodeId: "6", field: "text" } }],
});

// edit-style descriptor carrying an image-type slot (LoadImage node), shared by the
// reference-image upload tests below.
const editDescriptor = workflowDescriptorSchema.parse({
  workflowKey: "edit-wf", modelId: "edit-m", backendKind: "comfyui", version: 1,
  comfyWorkflow: { id: "22222222-2222-4222-8222-222222222222", name: "iDream Test Edit" },
  capabilities: ["img2img", "edit", "referenceImages"],
  identity: {
    mode: "single_reference",
    maxReferences: 1,
    acceptedRoles: ["identity_anchor", "identity_reference", "source_image"],
    supportsLookReference: false,
    supportsSourceImageWithIdentity: false,
  },
  apiPrompt: {
    "8": { class_type: "LoadImage", inputs: { image: "" } },
    "3": { class_type: "TextEncodeQwenImageEditPlus", inputs: { prompt: "" } },
    "9": { class_type: "SaveImage", inputs: {} },
  },
  inputs: [
    { key: "edit_prompt", type: "text", target: { nodeId: "3", field: "prompt" } },
    {
      key: "source_image",
      type: "image",
      referenceRoles: ["identity_anchor", "identity_reference", "source_image"],
      target: { nodeId: "8", field: "image" },
    },
  ],
});

const combinedDescriptor = workflowDescriptorSchema.parse({
  workflowKey: "combined-edit-wf",
  modelId: "combined-edit-m",
  backendKind: "comfyui",
  version: 1,
  comfyWorkflow: {
    id: "33333333-3333-4333-8333-333333333333",
    name: "iDream Test Combined Edit",
  },
  capabilities: ["img2img", "edit", "referenceImages"],
  identity: {
    mode: "multi_reference",
    maxReferences: 2,
    acceptedRoles: ["identity_anchor", "identity_reference", "source_image"],
    supportsLookReference: false,
    supportsSourceImageWithIdentity: true,
  },
  apiPrompt: {
    "8": { class_type: "LoadImage", inputs: { image: "" } },
    "12": { class_type: "LoadImage", inputs: { image: "" } },
    "3": { class_type: "TextEncodeQwenImageEditPlus", inputs: { prompt: "" } },
    "9": { class_type: "SaveImage", inputs: {} },
  },
  inputs: [
    { key: "edit_prompt", type: "text", target: { nodeId: "3", field: "prompt" } },
    {
      key: "identity_image",
      type: "image",
      referenceRoles: ["identity_anchor", "identity_reference"],
      target: { nodeId: "12", field: "image" },
    },
    {
      key: "source_image",
      type: "image",
      referenceRoles: ["source_image"],
      target: { nodeId: "8", field: "image" },
    },
  ],
});

const lookDescriptor = workflowDescriptorSchema.parse({
  workflowKey: "identity-look-wf",
  modelId: "identity-look-m",
  backendKind: "comfyui",
  version: 1,
  comfyWorkflow: {
    id: "44444444-4444-4444-8444-444444444444",
    name: "iDream Test Identity and Look",
  },
  capabilities: ["edit", "referenceImages"],
  identity: {
    mode: "multi_identity",
    maxReferences: 2,
    acceptedRoles: [
      "identity_anchor",
      "identity_reference",
      "look_reference",
    ],
    supportsLookReference: true,
    supportsSourceImageWithIdentity: false,
  },
  apiPrompt: {
    "3": {
      class_type: "TextEncodeQwenImageEditPlus",
      inputs: {
        image1: ["8", 0],
        image2: ["12", 0],
        prompt: "",
      },
    },
    "8": { class_type: "LoadImage", inputs: { image: "" } },
    "12": { class_type: "LoadImage", inputs: { image: "" } },
    "9": { class_type: "SaveImage", inputs: {} },
  },
  inputs: [
    {
      key: "edit_prompt",
      type: "text",
      target: { nodeId: "3", field: "prompt" },
    },
    {
      key: "identity_anchor",
      type: "image",
      required: true,
      referenceRoles: ["identity_anchor"],
      target: { nodeId: "8", field: "image" },
    },
    {
      key: "identity_reference",
      type: "image",
      required: true,
      referenceRoles: ["identity_reference", "look_reference"],
      target: { nodeId: "12", field: "image" },
    },
  ],
});

const videoDescriptor = workflowDescriptorSchema.parse({
  workflowKey: "ltx-video-test",
  modelId: "ltx-video-test",
  backendKind: "comfyui",
  version: 1,
  comfyWorkflow: {
    id: "55555555-5555-4555-8555-555555555555",
    name: "iDream Test Video",
  },
  capabilities: ["video", "img2video", "referenceImages"],
  identity: {
    mode: "single_reference",
    maxReferences: 1,
    acceptedRoles: ["source_image"],
    supportsLookReference: false,
    supportsSourceImageWithIdentity: false,
  },
  apiPrompt: {
    "8": { class_type: "LoadImage", inputs: { image: "" } },
    "75": { class_type: "SaveVideo", inputs: {} },
  },
  inputs: [
    {
      key: "source_image",
      type: "image",
      referenceRoles: ["source_image"],
      target: { nodeId: "8", field: "image" },
    },
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
const MP4 = new Uint8Array([
  0x00, 0x00, 0x00, 0x18,
  0x66, 0x74, 0x79, 0x70,
  0x69, 0x73, 0x6f, 0x6d,
  0x00, 0x00, 0x02, 0x00,
  0x69, 0x73, 0x6f, 0x6d,
  0x6d, 0x70, 0x34, 0x32,
]);

function mockFetch(seq: Array<() => Response>) {
  let i = 0;
  return vi.fn(async (..._args: Parameters<typeof fetch>) => seq[Math.min(i++, seq.length - 1)]());
}

async function testWorkflowSync(input: {
  descriptor: { comfyWorkflow: { id: string; name: string } };
}) {
  return {
    id: input.descriptor.comfyWorkflow.id,
    name: input.descriptor.comfyWorkflow.name,
  };
}

function makeBackend() {
  return new ComfyUIBackend({ apiUrl: "http://x", workflowSync: testWorkflowSync });
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
    const backend = makeBackend();
    const handle = await backend.submit({ descriptor, slots: { prompt: "cat" }, timeoutMs: 5000 });
    expect(handle.id).toBe("p1");
    const result = await backend.poll(handle);
    expect(result.assets).toHaveLength(1);
    expect(result.assets[0].body.byteLength).toBeGreaterThan(0);
    // submitted body carried the bound slot
    const submitBody = JSON.parse((g.mock.calls[0][1] as RequestInit).body as string);
    expect(submitBody.prompt["6"].inputs.text).toBe("cat");
    expect(submitBody.extra_data).toEqual({
      extra_pnginfo: {
        workflow: {
          id: "11111111-1111-4111-8111-111111111111",
          name: "iDream Test T2I",
        },
      },
      idream_workflow: {
        key: "t2i",
        model_id: "redcraft-krea2-comfyui",
        version: 1,
      },
    });
  });

  it("polls an animated ComfyUI output as MP4 for video workflows", async () => {
    const g = mockFetch([
      () => new Response(JSON.stringify({ name: "source.webp", subfolder: "", type: "input" })),
      () => new Response(JSON.stringify({ prompt_id: "video-p1" }), { status: 200 }),
      () => new Response(JSON.stringify({
        "video-p1": {
          status: { completed: true },
          outputs: {
            "75": {
              images: [{
                filename: "result.mp4",
                subfolder: "",
                type: "output",
                animated: [true],
              }],
            },
          },
        },
      }), { status: 200 }),
      () => new Response(MP4, {
        status: 200,
        headers: { "content-type": "video/mp4" },
      }),
    ]);
    vi.stubGlobal("fetch", g);
    const backend = makeBackend();
    const handle = await backend.submit({
      descriptor: videoDescriptor,
      slots: { width: 768, height: 1152 },
      referenceImages: [{
        assetId: "source-1",
        role: "source_image",
        b64Json: PNG_B64,
        contentType: "image/png",
      }],
      timeoutMs: 5_000,
    });

    const result = await backend.poll(handle);

    expect(result.assets).toEqual([
      {
        body: MP4,
        width: 768,
        height: 1152,
        contentType: "video/mp4",
      },
    ]);
  });
  it("throws when prompt is rejected (no prompt_id)", async () => {
    vi.stubGlobal("fetch", mockFetch([() => new Response(JSON.stringify({ node_errors: { "6": "bad" } }), { status: 200 })]));
    const backend = makeBackend();
    await expect(backend.submit({ descriptor, slots: { prompt: "cat" }, timeoutMs: 5000 })).rejects.toThrow();
  });
  it("rejects references when the workflow has no semantic image slots", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const backend = makeBackend();
    await expect(
      backend.submit({
        descriptor,
        slots: { prompt: "cat" },
        referenceImages: [{
          assetId: "unexpected-reference",
          role: "identity_anchor",
          b64Json: PNG_B64,
        }],
        timeoutMs: 5_000,
      }),
    ).rejects.toThrow(
      "workflow t2i requires 0 semantic image references but received 1",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("uploads reference image and binds filename into image slot", async () => {
    const g = mockFetch([
      () => new Response(JSON.stringify({ name: "up.png", subfolder: "", type: "input" }), { status: 200 }), // upload
      () => new Response(JSON.stringify({ prompt_id: "p9" }), { status: 200 }), // prompt
    ]);
    vi.stubGlobal("fetch", g);
    const backend = makeBackend();
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
    const backend = makeBackend();
    await expect(
      backend.submit({
        descriptor: editDescriptor,
        slots: { edit_prompt: "red dress" },
        referenceImages: [],
        timeoutMs: 5000,
      }),
    ).rejects.toThrow(
      "workflow edit-wf requires 1 semantic image references but received 0",
    );
  });
  it("fetches reference image bytes from url when b64Json is absent", async () => {
    const g = mockFetch([
      () => new Response(PNG, { status: 200, headers: { "content-type": "image/png" } }), // url fetch
      () => new Response(JSON.stringify({ name: "url.png", subfolder: "in", type: "input" }), { status: 200 }), // upload
      () => new Response(JSON.stringify({ prompt_id: "p10" }), { status: 200 }), // prompt
    ]);
    vi.stubGlobal("fetch", g);
    const backend = makeBackend();
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

  it("binds combined source and identity references by role instead of array order", async () => {
    const g = mockFetch([
      () => new Response(
        JSON.stringify({ name: "identity.png", subfolder: "", type: "input" }),
        { status: 200 },
      ),
      () => new Response(
        JSON.stringify({ name: "source.png", subfolder: "", type: "input" }),
        { status: 200 },
      ),
      () => new Response(JSON.stringify({ prompt_id: "combined-prompt" }), {
        status: 200,
      }),
    ]);
    vi.stubGlobal("fetch", g);
    const backend = makeBackend();
    await backend.submit({
      descriptor: combinedDescriptor,
      slots: { edit_prompt: "keep identity, change pose" },
      referenceImages: [
        { assetId: "same-asset", role: "source_image", b64Json: PNG_B64 },
        { assetId: "same-asset", role: "identity_anchor", b64Json: PNG_B64 },
      ],
      timeoutMs: 5_000,
    });

    const promptBody = JSON.parse(
      (g.mock.calls[2][1] as RequestInit).body as string,
    );
    expect(promptBody.prompt["12"].inputs.image).toBe("identity.png");
    expect(promptBody.prompt["8"].inputs.image).toBe("source.png");
  });

  it("binds a shuffled Look reference to its semantic slot, even for the same asset", async () => {
    const g = mockFetch([
      () => new Response(
        JSON.stringify({ name: "anchor.png", subfolder: "", type: "input" }),
        { status: 200 },
      ),
      () => new Response(
        JSON.stringify({ name: "look.png", subfolder: "", type: "input" }),
        { status: 200 },
      ),
      () => new Response(JSON.stringify({ prompt_id: "look-prompt" }), {
        status: 200,
      }),
    ]);
    vi.stubGlobal("fetch", g);
    const backend = makeBackend();
    await backend.submit({
      descriptor: lookDescriptor,
      slots: { edit_prompt: "preserve identity, borrow the visual look" },
      referenceImages: [
        {
          assetId: "shared-asset",
          role: "look_reference",
          b64Json: PNG_B64,
        },
        {
          assetId: "shared-asset",
          role: "identity_anchor",
          b64Json: PNG_B64,
        },
      ],
      timeoutMs: 5_000,
    });

    const promptBody = JSON.parse(
      (g.mock.calls[2][1] as RequestInit).body as string,
    );
    expect(promptBody.prompt["8"].inputs.image).toBe("anchor.png");
    expect(promptBody.prompt["12"].inputs.image).toBe("look.png");
  });

  it("rejects an incomplete concrete image-slot assignment before upload", async () => {
    const backend = makeBackend();
    await expect(backend.submit({
      descriptor: combinedDescriptor,
      slots: { edit_prompt: "keep identity" },
      referenceImages: [
        { assetId: "identity", role: "identity_anchor", b64Json: PNG_B64 },
      ],
      timeoutMs: 5_000,
    })).rejects.toThrow(
      "requires 2 semantic image references but received 1",
    );
  });
});
