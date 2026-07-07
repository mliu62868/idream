import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildBackendRegistry } from "./registry";

function descriptorJson(modelId: string, backendKind: "comfyui" | "sdcpp", workflowKey = `${backendKind}-t2i`) {
  return JSON.stringify({
    workflowKey,
    modelId,
    backendKind,
    version: 1,
    capabilities: ["textToImage"],
    apiPrompt: {},
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
    await writeFile(path.join(dir, "comfy.json"), descriptorJson("redcraft-krea2-comfyui", "comfyui"));
    await writeFile(path.join(dir, "sdcpp.json"), descriptorJson("z-turbo", "sdcpp"));

    const registry = await buildBackendRegistry({
      comfyApiUrl: "http://127.0.0.1:8188",
      sdcppCli: "/bin/true",
      workflowDir: dir,
    });

    const comfy = registry.resolveForModel("redcraft-krea2-comfyui");
    expect(comfy.backend.kind).toBe("comfyui");
    expect(comfy.descriptor.modelId).toBe("redcraft-krea2-comfyui");

    const sdcpp = registry.resolveForModel("z-turbo");
    expect(sdcpp.backend.kind).toBe("sdcpp");
    expect(sdcpp.descriptor.modelId).toBe("z-turbo");

    // Same backend instance is reused across models of the same kind.
    const comfyAgain = registry.resolveForModel("redcraft-krea2-comfyui");
    expect(comfyAgain.backend).toBe(comfy.backend);
  });

  it("throws a clear error for an unknown modelId", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "gen-registry-"));
    await writeFile(path.join(dir, "comfy.json"), descriptorJson("redcraft-krea2-comfyui", "comfyui"));

    const registry = await buildBackendRegistry({
      comfyApiUrl: "http://127.0.0.1:8188",
      sdcppCli: "/bin/true",
      workflowDir: dir,
    });

    expect(() => registry.resolveForModel("nope")).toThrow(/nope/);
  });

  it("resolves by workflowKey as well as modelId (dual index)", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "gen-registry-"));
    await writeFile(path.join(dir, "comfy.json"), descriptorJson("redcraft-krea2-comfyui", "comfyui"));
    await writeFile(path.join(dir, "sdcpp.json"), descriptorJson("z-turbo", "sdcpp"));

    const registry = await buildBackendRegistry({
      comfyApiUrl: "http://127.0.0.1:8188",
      sdcppCli: "/bin/true",
      workflowDir: dir,
    });

    const comfyByModelId = registry.resolveForModel("redcraft-krea2-comfyui");
    const comfyByWorkflowKey = registry.resolveForModel("comfyui-t2i");
    expect(comfyByWorkflowKey.descriptor).toBe(comfyByModelId.descriptor);
    expect(comfyByWorkflowKey.backend).toBe(comfyByModelId.backend);

    const sdcppByModelId = registry.resolveForModel("z-turbo");
    const sdcppByWorkflowKey = registry.resolveForModel("sdcpp-t2i");
    expect(sdcppByWorkflowKey.descriptor).toBe(sdcppByModelId.descriptor);
    expect(sdcppByWorkflowKey.backend).toBe(sdcppByModelId.backend);
  });

  it("throws a clear error for an unknown workflowKey", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "gen-registry-"));
    await writeFile(path.join(dir, "comfy.json"), descriptorJson("redcraft-krea2-comfyui", "comfyui"));

    const registry = await buildBackendRegistry({
      comfyApiUrl: "http://127.0.0.1:8188",
      sdcppCli: "/bin/true",
      workflowDir: dir,
    });

    expect(() => registry.resolveForModel("nope-workflow")).toThrow(/nope-workflow/);
  });

  it("rejects at build time when a workflowKey collides with a different descriptor's modelId", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "gen-registry-"));
    await writeFile(path.join(dir, "a.json"), descriptorJson("model-a", "comfyui", "workflow-a"));
    // file b's workflowKey ("model-a") collides with file a's modelId ("model-a").
    await writeFile(path.join(dir, "b.json"), descriptorJson("model-b", "sdcpp", "model-a"));

    await expect(
      buildBackendRegistry({
        comfyApiUrl: "http://127.0.0.1:8188",
        sdcppCli: "/bin/true",
        workflowDir: dir,
      }),
    ).rejects.toThrow(/duplicate registry key/);
  });

  it("rejects at build time when two descriptors share the same modelId", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "gen-registry-"));
    await writeFile(path.join(dir, "a.json"), descriptorJson("dup-model", "comfyui", "workflow-a"));
    await writeFile(path.join(dir, "b.json"), descriptorJson("dup-model", "sdcpp", "workflow-b"));

    await expect(
      buildBackendRegistry({
        comfyApiUrl: "http://127.0.0.1:8188",
        sdcppCli: "/bin/true",
        workflowDir: dir,
      }),
    ).rejects.toThrow(/duplicate registry key/);
  });
});
