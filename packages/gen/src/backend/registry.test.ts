import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildBackendRegistry } from "./registry";
import { assignWorkflowReferenceSlots, bindComfySlots } from "./workflow";

function descriptorJson(
  modelId: string,
  backendKind: "comfyui" | "drawthings",
  workflowKey = `${backendKind}-t2i`,
) {
  return JSON.stringify({
    workflowKey,
    modelId,
    backendKind,
    version: 1,
    capabilities: ["textToImage"],
    ...(backendKind === "comfyui" ? {
      comfyWorkflow: { id: "11111111-1111-4111-8111-111111111111", name: workflowKey },
      apiPrompt: {},
    } : {}),
    ...(backendKind === "drawthings" ? { drawThings: { model: `${modelId}.ckpt` } } : {}),
    inputs: [],
  });
}

describe("buildBackendRegistry", () => {
  let dir: string | undefined;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("indexes descriptors by modelId and resolves the matching backend kind", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "gen-registry-"));
    await writeFile(path.join(dir, "comfy.json"), descriptorJson("redcraft-krea2-redmix3-fp8", "comfyui"));
    await writeFile(path.join(dir, "drawthings.json"), descriptorJson("z-turbo", "drawthings"));

    const registry = await buildBackendRegistry({
      comfyApiUrl: "http://127.0.0.1:8188",
      workflowDir: dir,
    });

    const comfy = registry.resolveForModel("redcraft-krea2-redmix3-fp8");
    expect(comfy.backend.kind).toBe("comfyui");
    expect(comfy.descriptor.modelId).toBe("redcraft-krea2-redmix3-fp8");

    const drawthings = registry.resolveForModel("z-turbo");
    expect(drawthings.backend.kind).toBe("drawthings");
    expect(drawthings.descriptor.modelId).toBe("z-turbo");

    // Same backend instance is reused across models of the same kind.
    const comfyAgain = registry.resolveForModel("redcraft-krea2-redmix3-fp8");
    expect(comfyAgain.backend).toBe(comfy.backend);
  });

  it("resolves Draw Things descriptors by model id and workflow key", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "gen-registry-"));
    await writeFile(
      path.join(dir, "drawthings.json"),
      descriptorJson("pornmaster-zimage-drawthings", "drawthings"),
    );

    const registry = await buildBackendRegistry({
      comfyApiUrl: "http://127.0.0.1:8188",
      drawThingsCli: "/bin/true",
      workflowDir: dir,
    });

    const byModel = registry.resolveForModel("pornmaster-zimage-drawthings");
    const byWorkflow = registry.resolveForModel("drawthings-t2i");
    expect(byModel.backend.kind).toBe("drawthings");
    expect(byWorkflow.backend).toBe(byModel.backend);
  });

  it("throws a clear error for an unknown modelId", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "gen-registry-"));
    await writeFile(path.join(dir, "comfy.json"), descriptorJson("redcraft-krea2-redmix3-fp8", "comfyui"));

    const registry = await buildBackendRegistry({
      comfyApiUrl: "http://127.0.0.1:8188",
      workflowDir: dir,
    });

    expect(() => registry.resolveForModel("nope")).toThrow(/nope/);
  });

  it("resolves by workflowKey as well as modelId (dual index)", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "gen-registry-"));
    await writeFile(path.join(dir, "comfy.json"), descriptorJson("redcraft-krea2-redmix3-fp8", "comfyui"));
    await writeFile(path.join(dir, "drawthings.json"), descriptorJson("z-turbo", "drawthings"));

    const registry = await buildBackendRegistry({
      comfyApiUrl: "http://127.0.0.1:8188",
      workflowDir: dir,
    });

    const comfyByModelId = registry.resolveForModel("redcraft-krea2-redmix3-fp8");
    const comfyByWorkflowKey = registry.resolveForModel("comfyui-t2i");
    expect(comfyByWorkflowKey.descriptor).toBe(comfyByModelId.descriptor);
    expect(comfyByWorkflowKey.backend).toBe(comfyByModelId.backend);

    const drawthingsByModelId = registry.resolveForModel("z-turbo");
    const drawthingsByWorkflowKey = registry.resolveForModel("drawthings-t2i");
    expect(drawthingsByWorkflowKey.descriptor).toBe(drawthingsByModelId.descriptor);
    expect(drawthingsByWorkflowKey.backend).toBe(drawthingsByModelId.backend);
  });

  it("throws a clear error for an unknown workflowKey", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "gen-registry-"));
    await writeFile(path.join(dir, "comfy.json"), descriptorJson("redcraft-krea2-redmix3-fp8", "comfyui"));

    const registry = await buildBackendRegistry({
      comfyApiUrl: "http://127.0.0.1:8188",
      workflowDir: dir,
    });

    expect(() => registry.resolveForModel("nope-workflow")).toThrow(/nope-workflow/);
  });

  it("rejects at build time when a workflowKey collides with a different descriptor's modelId", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "gen-registry-"));
    await writeFile(path.join(dir, "a.json"), descriptorJson("model-a", "comfyui", "workflow-a"));
    // file b's workflowKey ("model-a") collides with file a's modelId ("model-a").
    await writeFile(path.join(dir, "b.json"), descriptorJson("model-b", "drawthings", "model-a"));

    await expect(
      buildBackendRegistry({
        comfyApiUrl: "http://127.0.0.1:8188",
        workflowDir: dir,
      }),
    ).rejects.toThrow(/duplicate registry key/);
  });

  it("rejects at build time when two descriptors share the same modelId", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "gen-registry-"));
    await writeFile(path.join(dir, "a.json"), descriptorJson("dup-model", "comfyui", "workflow-a"));
    await writeFile(path.join(dir, "b.json"), descriptorJson("dup-model", "drawthings", "workflow-b"));

    await expect(
      buildBackendRegistry({
        comfyApiUrl: "http://127.0.0.1:8188",
        workflowDir: dir,
      }),
    ).rejects.toThrow(/duplicate registry key/);
  });

  it("allows a descriptor whose workflowKey equals its own modelId (self-collision is not an error)", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "registry-self-"));
    await writeFile(
      path.join(dir, "solo.json"),
      descriptorJson("solo-model", "comfyui", "solo-model"),
    );

    const registry = await buildBackendRegistry({
      comfyApiUrl: "http://127.0.0.1:8188",
      workflowDir: dir,
    });

    const byModel = registry.resolveForModel("solo-model");
    expect(byModel.descriptor.modelId).toBe("solo-model");
    expect(byModel.descriptor.workflowKey).toBe("solo-model");
  });

  // SPEC: the shipped Draw Things descriptor declares img2img, and
  // DrawThingsBackend implements it (--image/--strength off one source_image).
  // It used to declare maxReferences:0 at the same time, which made every
  // img2img attempt fail the reference-cardinality check before the CLI ran.
  it("admits one source image on the shipped Draw Things img2img descriptor", async () => {
    const registry = await buildBackendRegistry({
      comfyApiUrl: "http://127.0.0.1:8188",
      workflowDir: path.resolve(import.meta.dirname, "../../workflows"),
    });
    const descriptor = registry.resolveForModel("pornmaster-zimage-drawthings").descriptor;

    expect(descriptor.capabilities).toContain("img2img");
    expect(assignWorkflowReferenceSlots(descriptor, ["source_image"])).toMatchObject({ ok: true });
  });

  it("binds production ComfyUI workflow slots, including both identity references", async () => {
    const registry = await buildBackendRegistry({
      comfyApiUrl: "http://127.0.0.1:8188",
      workflowDir: path.resolve(import.meta.dirname, "../../workflows"),
    });
    const qwen = registry.resolveForModel("qwen-image-edit-img2img").descriptor;
    const qwenPrompt = bindComfySlots(qwen, {
      prompt: "same adult character in a cafe",
      negative: "text, watermark, duplicate person",
      source_image: "anchor.png",
      seed: 7,
    });
    expect(qwenPrompt["4"].inputs.prompt).toBe("text, watermark, duplicate person");

    const multiIdentity = registry.resolveForModel(
      "qwen-image-edit-multi-identity",
    ).descriptor;
    const multiIdentityPrompt = bindComfySlots(multiIdentity, {
      prompt: "preserve the same adult character",
      negative: "text, watermark, duplicate person",
      identity_anchor: "anchor.png",
      identity_reference: "look.png",
      seed: 8,
    });
    expect(multiIdentityPrompt["3"].inputs).toMatchObject({
      image1: ["8", 0],
      image2: ["12", 0],
    });
    expect(multiIdentityPrompt["8"].inputs.image).toBe("anchor.png");
    expect(multiIdentityPrompt["12"].inputs.image).toBe("look.png");

    const multiReference = registry.resolveForModel(
      "qwen-image-edit-multi-reference",
    ).descriptor;
    const multiReferencePrompt = bindComfySlots(multiReference, {
      prompt: "preserve identity while following the source composition",
      negative: "text, watermark, duplicate person",
      identity_image: "identity.png",
      source_image: "source.png",
      seed: 9,
    });
    expect(multiReferencePrompt["3"].inputs).toMatchObject({
      image1: ["8", 0],
      image2: ["12", 0],
    });
    expect(multiReferencePrompt["8"].inputs.image).toBe("identity.png");
    expect(multiReferencePrompt["12"].inputs.image).toBe("source.png");

    const redcraft = registry.resolveForModel("redcraft-krea2-redmix3-txt2img").descriptor;
    const redcraftPrompt = bindComfySlots(redcraft, {
      prompt: "editorial portrait",
      negative: "text, watermark, extra subject",
      seed: 10,
    });
    expect(redcraftPrompt["5"]).toMatchObject({
      class_type: "CLIPTextEncode",
      inputs: { text: "text, watermark, extra subject" },
    });

    const redMix3 = registry.resolveForModel(
      "redcraft-krea2-redmix3-fp8",
    ).descriptor;
    const redMix3Prompt = bindComfySlots(redMix3, {
      prompt: "editorial portrait with dramatic foreground perspective",
      negative: "text, watermark, extra subject",
      seed: 11,
    });
    expect(redMix3Prompt["1"]?.inputs).toEqual({
      unet_name: "Krea2RedMix3.0-fp8-scaled-ComfyUI.safetensors",
      weight_dtype: "default",
    });
    expect(redMix3Prompt["5"]?.inputs.text).toBe(
      "text, watermark, extra subject",
    );
    expect(redMix3Prompt["7"]?.inputs).toMatchObject({
      seed: 11,
      steps: 12,
      sampler_name: "euler",
      scheduler: "simple",
    });
  });
});
