import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildBackendRegistry } from "./registry";

function descriptorJson(modelId: string, backendKind: "comfyui" | "sdcpp") {
  return JSON.stringify({
    workflowKey: `${backendKind}-t2i`,
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
});
