import { describe, expect, it, vi } from "vitest";
import { BackendImageModel } from "./backend-image-model";
import type { GenBackend } from "./types";
import { workflowDescriptorSchema } from "./workflow";

// 2x2 PNG (checkerboard black/white) — same fixture used by comfyui.test.ts /
// sdcpp.test.ts. These tests inject a stub GenBackend directly (no real sanity
// check runs), so the bytes just need to be non-empty/valid-looking.
const PNG = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAE0lEQVR4nGNgYGD4//8/GDMwAAAp5AX71ZPZmwAAAABJRU5ErkJggg=="),
  (c) => c.charCodeAt(0),
);

const descriptor = workflowDescriptorSchema.parse({
  workflowKey: "t2i",
  modelId: "m",
  backendKind: "comfyui",
  version: 1,
  capabilities: ["textToImage"],
  apiPrompt: {},
  inputs: [],
});

function makeStubBackend(overrides?: Partial<GenBackend>): GenBackend {
  return {
    id: "stub",
    kind: "comfyui",
    capabilities: () => ({
      textToImage: true,
      img2img: false,
      referenceImages: false,
      stableSeed: true,
      edit: false,
    }),
    submit: vi.fn(async () => ({ id: "handle-1" })),
    poll: vi.fn(async () => ({
      assets: [{ body: PNG, width: 832, height: 1216, contentType: "image/png" }],
    })),
    health: vi.fn(async () => ({ ok: true })),
    ...overrides,
  };
}

describe("BackendImageModel", () => {
  it("loops submit/poll `count` times with an incrementing seed and maps assets", async () => {
    const backend = makeStubBackend();
    const registry = { resolveForModel: vi.fn(() => ({ backend, descriptor })) };
    const model = new BackendImageModel(registry);

    const result = await model.generate({
      prompt: "a cat",
      count: 2,
      model: "m",
      orientation: "portrait",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok result");
    expect(result.data.assets).toHaveLength(2);
    const [firstAsset] = result.data.assets;
    expect(firstAsset).toMatchObject({ width: 832, height: 1216, contentType: "image/png" });
    expect(firstAsset?.body?.byteLength).toBeGreaterThan(0);

    expect(backend.submit).toHaveBeenCalledTimes(2);
    expect(backend.poll).toHaveBeenCalledTimes(2);
    const submitMock = backend.submit as unknown as ReturnType<typeof vi.fn>;
    const seeds = submitMock.mock.calls.map((call: unknown[]) => (call[0] as { slots: { seed: number } }).slots.seed);
    expect(seeds).toEqual([0, 1]);
    const sizes = submitMock.mock.calls.map(
      (call: unknown[]) => (call[0] as { slots: { width: number; height: number } }).slots,
    );
    expect(sizes[0]).toMatchObject({ width: 832, height: 1216 });
  });

  it("maps a thrown poll error to ok:false with retryable:true", async () => {
    const backend = makeStubBackend({
      poll: vi.fn(async () => {
        throw new Error("network blip");
      }),
    });
    const registry = { resolveForModel: vi.fn(() => ({ backend, descriptor })) };
    const model = new BackendImageModel(registry);

    const result = await model.generate({ prompt: "a cat", count: 1, model: "m" });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure result");
    expect(result.error.code).toBe("backend_error");
    expect(result.error.retryable).toBe(true);
    expect(result.error.message).toContain("network blip");
  });

  it("maps an unknown model (registry throws) to ok:false with retryable:false", async () => {
    const registry = {
      resolveForModel: vi.fn(() => {
        throw new Error('buildBackendRegistry: unknown modelId "nope"');
      }),
    };
    const model = new BackendImageModel(registry);

    const result = await model.generate({ prompt: "a cat", count: 1, model: "nope" });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure result");
    expect(result.error.code).toBe("unknown_model");
    expect(result.error.retryable).toBe(false);
    expect(result.error.message).toContain("nope");
  });
});
