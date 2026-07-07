import { describe, expect, it, vi } from "vitest";
import { stableNumericSeed } from "../providers";
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

// Pulls the raw `slots` object BackendImageModel.generate() passed to backend.submit()
// for a given loop iteration (defaults to the first submit() call).
function submittedSlots(backend: GenBackend, callIndex = 0): Record<string, string | number> {
  const submitMock = backend.submit as unknown as ReturnType<typeof vi.fn>;
  const call = submitMock.mock.calls[callIndex] as unknown[];
  return (call[0] as { slots: Record<string, string | number> }).slots;
}

function modelWith(backend: GenBackend): BackendImageModel {
  const registry = { resolveForModel: vi.fn(() => ({ backend, descriptor })) };
  return new BackendImageModel(registry);
}

describe("BackendImageModel", () => {
  it("loops submit/poll `count` times with an incrementing seed and maps assets", async () => {
    const backend = makeStubBackend();
    const registry = { resolveForModel: vi.fn(() => ({ backend, descriptor })) };
    const model = new BackendImageModel(registry);

    // Explicit numeric seed here keeps this test focused on loop/asset-mapping
    // behavior — default-seed hashing (no seed supplied) has its own dedicated
    // tests below.
    const result = await model.generate({
      prompt: "a cat",
      count: 2,
      model: "m",
      orientation: "portrait",
      seed: "5",
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
    expect(seeds).toEqual([5, 6]);
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

// SPEC: orientation -> {width,height} wire-contract table. These pin the exact
// dimensions BackendImageModel computes so a regression back to the old
// portrait/landscape/square-only switch (which silently defaulted every real wire
// value to 1024x1024) can't reopen unnoticed.
describe("BackendImageModel orientation sizing (wire contract)", () => {
  it('"4:5" is taller than wide and is NOT the old 1024x1024 default', async () => {
    const backend = makeStubBackend();
    await modelWith(backend).generate({ prompt: "a cat", count: 1, model: "m", orientation: "4:5" });

    const slots = submittedSlots(backend);
    expect(slots).toMatchObject({ width: 832, height: 1024 });
    expect((slots.height as number)).toBeGreaterThan(slots.width as number);
    expect(slots).not.toMatchObject({ width: 1024, height: 1024 });
  });

  it('"16:9" is wider than tall', async () => {
    const backend = makeStubBackend();
    await modelWith(backend).generate({ prompt: "a cat", count: 1, model: "m", orientation: "16:9" });

    const slots = submittedSlots(backend);
    expect(slots).toMatchObject({ width: 1472, height: 832 });
    expect(slots.width as number).toBeGreaterThan(slots.height as number);
  });

  it('"1:1" is square', async () => {
    const backend = makeStubBackend();
    await modelWith(backend).generate({ prompt: "a cat", count: 1, model: "m", orientation: "1:1" });

    const slots = submittedSlots(backend);
    expect(slots.width).toBe(slots.height);
    expect(slots).toMatchObject({ width: 832, height: 832 });
  });

  it('legacy "portrait" still maps to its original dimensions', async () => {
    const backend = makeStubBackend();
    await modelWith(backend).generate({ prompt: "a cat", count: 1, model: "m", orientation: "portrait" });

    expect(submittedSlots(backend)).toMatchObject({ width: 832, height: 1216 });
  });

  it('unknown orientation "weird" falls back to the same dims as "4:5"', async () => {
    const backend = makeStubBackend();
    await modelWith(backend).generate({ prompt: "a cat", count: 1, model: "m", orientation: "weird" });

    expect(submittedSlots(backend)).toMatchObject({ width: 832, height: 1024 });
  });

  it("omits width/height from the submitted slots when orientation is undefined", async () => {
    const backend = makeStubBackend();
    await modelWith(backend).generate({ prompt: "a cat", count: 1, model: "m" });

    const slots = submittedSlots(backend);
    expect(slots).not.toHaveProperty("width");
    expect(slots).not.toHaveProperty("height");
  });

  it("controls.width/height still override even without an orientation", async () => {
    const backend = makeStubBackend();
    await modelWith(backend).generate({
      prompt: "a cat",
      count: 1,
      model: "m",
      controls: { width: 500, height: 700 },
    });

    expect(submittedSlots(backend)).toMatchObject({ width: 500, height: 700 });
  });
});

// SPEC: main's wire contract sends `seed: job.seed ?? job.id` where job.id is a
// non-numeric random string (packages/main service.ts) — most real seeds are NOT
// numeric. These pin that BackendImageModel hashes non-numeric seeds via
// providers.ts's stableNumericSeed instead of coercing them to 0 (which used to
// make every batched job collide on the same seed).
describe("BackendImageModel seed hashing (wire contract)", () => {
  it("hashes a non-numeric seed via stableNumericSeed instead of colliding at 0", async () => {
    const backend = makeStubBackend();
    await modelWith(backend).generate({ prompt: "a cat", count: 1, model: "m", seed: "cjob123abc" });

    const seed = submittedSlots(backend).seed;
    expect(seed).toBe(stableNumericSeed("cjob123abc"));
    expect(seed).not.toBe(0);
  });

  it("hashes two different non-numeric seeds to two different slot seeds", async () => {
    const backendA = makeStubBackend();
    await modelWith(backendA).generate({ prompt: "a cat", count: 1, model: "m", seed: "cjob-aaa111" });

    const backendB = makeStubBackend();
    await modelWith(backendB).generate({ prompt: "a cat", count: 1, model: "m", seed: "cjob-bbb222" });

    expect(submittedSlots(backendA).seed).not.toBe(submittedSlots(backendB).seed);
  });

  it('uses a numeric seed string ("42") verbatim', async () => {
    const backend = makeStubBackend();
    await modelWith(backend).generate({ prompt: "a cat", count: 1, model: "m", seed: "42" });

    expect(submittedSlots(backend).seed).toBe(42);
  });

  it("increments the hashed base seed per batch index (count:2 -> [s, s+1])", async () => {
    const backend = makeStubBackend();
    await modelWith(backend).generate({ prompt: "a cat", count: 2, model: "m", seed: "cjob123abc" });

    const base = stableNumericSeed("cjob123abc") ?? 0;
    expect(submittedSlots(backend, 0).seed).toBe(base);
    expect(submittedSlots(backend, 1).seed).toBe(base + 1);
  });
});

describe("BackendImageModel numericControl", () => {
  it("ignores a non-integer steps control and falls back to the descriptor default", async () => {
    const backend = makeStubBackend();
    await modelWith(backend).generate({
      prompt: "a cat",
      count: 1,
      model: "m",
      controls: { steps: 7.5 },
    });

    expect(submittedSlots(backend)).not.toHaveProperty("steps");
  });
});
