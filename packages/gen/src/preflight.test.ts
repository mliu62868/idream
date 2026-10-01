import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const run = promisify(execFile);

it("rejects visible Qwen image models whose bytes differ from the qualified recipe", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "idream-qwen-preflight-"));
  const workflowDirectory = path.join(directory, "workflows");
  const modelRoot = path.join(directory, "models");
  const workflow = JSON.parse(await readFile(
    new URL("../workflows/qwen-image-edit-img2img.json", import.meta.url), "utf8",
  ));
  const visibleFiles = Object.fromEntries(Object.values(workflow.apiPrompt).flatMap((value) => {
    const node = value as { inputs: Record<string, unknown> };
    return Object.entries(node.inputs)
      .filter(([key]) => ["unet_name", "clip_name", "vae_name", "lora_name"].includes(key))
      .map(([key, name]) => [key, [[name]]]);
  }));
  // Reproduce the gap: dropdowns list the right names, but the encoder file has
  // different bytes. No generation or real model load is needed to detect it.
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    const node = request.url?.split("/object_info/")[1];
    response.end(JSON.stringify(node
      ? { [node]: { input: { required: visibleFiles } } }
      : { system: {}, devices: [] }));
  });
  try {
    await mkdir(workflowDirectory);
    await mkdir(path.join(modelRoot, "text_encoders"), { recursive: true });
    await writeFile(path.join(workflowDirectory, "edit.json"), JSON.stringify(workflow));
    await writeFile(path.join(modelRoot, "text_encoders/qwen3vl_8b_int8_convrot.safetensors"), "wrong model bytes");
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing test listener");
    const endpoint = `http://127.0.0.1:${address.port}`;
    const result = await run("bun", [path.resolve(import.meta.dirname, "preflight.ts")], {
      timeout: 10_000,
      env: {
        ...process.env,
        GEN_IMAGE_PROVIDER: "backend",
        GEN_VIDEO_PROVIDER: "mock",
        GEN_WORKFLOW_DIR: workflowDirectory,
        COMFYUI_MODEL_ROOT: modelRoot,
        COMFYUI_IMAGE_API_URL: endpoint,
        COMFYUI_VIDEO_API_URL: endpoint,
        COMFYUI_H3_API_URL: endpoint,
        FFPROBE_BIN: "/usr/bin/true",
        FFMPEG_BIN: "/usr/bin/true",
      },
    }).then(
      (value) => ({ code: 0, stdout: value.stdout }),
      (error: { code: number; stdout: string }) => ({ code: error.code, stdout: error.stdout }),
    );
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("qwen3vl_8b_int8_convrot.safetensors SHA-256");
    expect(result.stdout).toContain("redqw21_unlocked_v2_bf16.safetensors cannot be read");
    expect(result.stdout).toContain("qwen_image_2.1_vae_bf16.safetensors cannot be read");
    expect(result.stdout).toContain("Qwen-Image-2.1-viggle-turbo-v0.3-6step-lora-r128.safetensors cannot be read");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);
