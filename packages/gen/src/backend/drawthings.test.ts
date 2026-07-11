import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { workflowDescriptorSchema } from "./workflow";

const PNG = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAE0lEQVR4nGNgYGD4//8/GDMwAAAp5AX71ZPZmwAAAABJRU5ErkJggg=="),
  (char) => char.charCodeAt(0),
);

const state = vi.hoisted(() => ({
  calls: [] as Array<{ command: string; args: string[] }>,
  exitCode: 0,
  hang: false,
}));

vi.mock("node:child_process", () => ({
  spawn: vi.fn((command: string, args: string[], options?: { signal?: AbortSignal }) => {
    state.calls.push({ command, args });
    const child = new EventEmitter() as EventEmitter & Pick<ChildProcess, "stdout" | "stderr">;
    child.stdout = new EventEmitter() as ChildProcess["stdout"];
    child.stderr = new EventEmitter() as ChildProcess["stderr"];
    if (state.hang) {
      options?.signal?.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        child.emit("error", error);
      });
      return child as unknown as ChildProcess;
    }
    queueMicrotask(() => {
      void (async () => {
        if (state.exitCode === 0) {
          const outputIndex = args.indexOf("--output");
          const outputPath = outputIndex >= 0 ? args[outputIndex + 1] : undefined;
          if (outputPath) await writeFile(outputPath, PNG);
        } else {
          child.stderr?.emit("data", Buffer.from("draw-things-cli boom"));
        }
        child.emit("close", state.exitCode);
      })();
    });
    return child as unknown as ChildProcess;
  }),
}));

import { DrawThingsBackend } from "./drawthings";

const descriptor = workflowDescriptorSchema.parse({
  workflowKey: "drawthings-pornmaster-t2i",
  modelId: "pornmaster-zimage-drawthings",
  backendKind: "drawthings",
  version: 1,
  capabilities: ["textToImage", "img2img", "stableSeed"],
  drawThings: { model: "pornmasterzimage_turbov35bf16_f16.ckpt" },
  inputs: [
    { key: "prompt", type: "text", target: { argFlag: "--prompt" } },
    { key: "negative", type: "text", target: { argFlag: "--negative-prompt" }, default: "" },
    { key: "width", type: "int", target: { argFlag: "--width" }, default: 832 },
    { key: "height", type: "int", target: { argFlag: "--height" }, default: 1216 },
    { key: "seed", type: "int", target: { argFlag: "--seed" } },
    { key: "steps", type: "int", target: { argFlag: "--steps" }, default: 8 },
  ],
});

describe("DrawThingsBackend", () => {
  let outputDir: string;

  beforeEach(async () => {
    state.calls.length = 0;
    state.exitCode = 0;
    state.hang = false;
    outputDir = await mkdtemp(path.join(tmpdir(), "drawthings-backend-test-"));
  });

  afterEach(async () => {
    await rm(outputDir, { recursive: true, force: true });
  });

  it("runs one offline Draw Things CLI generation and returns the PNG from poll", async () => {
    const backend = new DrawThingsBackend({
      cli: "/usr/local/bin/draw-things-cli",
      modelsDir: "/draw-things-models",
      outputDir,
      offline: true,
    });
    const handle = await backend.submit({
      descriptor,
      slots: {
        prompt: "cinematic portrait",
        negative: "blurry",
        width: 832,
        height: 1216,
        seed: 42,
        steps: 10,
      },
      timeoutMs: 5_000,
    });

    expect(state.calls).toHaveLength(1);
    const [{ command, args }] = state.calls;
    expect(command).toBe("/usr/local/bin/draw-things-cli");
    expect(args.slice(0, 3)).toEqual([
      "generate",
      "--model",
      "pornmasterzimage_turbov35bf16_f16.ckpt",
    ]);
    expect(valueAfter(args, "--prompt")).toBe("cinematic portrait");
    expect(valueAfter(args, "--negative-prompt")).toBe("blurry");
    expect(valueAfter(args, "--width")).toBe("832");
    expect(valueAfter(args, "--height")).toBe("1216");
    expect(valueAfter(args, "--seed")).toBe("42");
    expect(valueAfter(args, "--steps")).toBe("10");
    expect(valueAfter(args, "--models-dir")).toBe("/draw-things-models");
    expect(args).toContain("--no-download-missing");
    expect(args).toContain("--offline");

    const result = await backend.poll(handle);
    expect(result.assets).toHaveLength(1);
    expect(result.assets[0]).toMatchObject({ width: 2, height: 2, contentType: "image/png" });
    expect(result.assets[0].body.byteLength).toBeGreaterThan(0);
  });

  it("reports executable health for explicit paths", async () => {
    const okBackend = new DrawThingsBackend({ cli: "/bin/ls", outputDir });
    await expect(okBackend.health()).resolves.toEqual({ ok: true });

    const missingBackend = new DrawThingsBackend({ cli: "/no/such/draw-things-cli", outputDir });
    const health = await missingBackend.health();
    expect(health.ok).toBe(false);
    expect(health.detail).toBeTruthy();
  });

  it("materializes one source image for img2img and removes it after generation", async () => {
    const backend = new DrawThingsBackend({ cli: "/bin/true", outputDir });
    await backend.submit({
      descriptor,
      slots: { prompt: "same portrait", seed: 9, strength: 0.7 },
      referenceImages: [
        {
          assetId: "source-1",
          role: "source_image",
          b64Json: Buffer.from(PNG).toString("base64"),
          contentType: "image/png",
        },
      ],
      timeoutMs: 5_000,
    });

    const args = state.calls[0]?.args ?? [];
    const sourcePath = valueAfter(args, "--image");
    expect(sourcePath).toBeTruthy();
    expect(valueAfter(args, "--strength")).toBe("0.7");
    await expect(access(sourcePath as string)).rejects.toThrow();
  });

  it("rejects identity references without starting the CLI", async () => {
    const backend = new DrawThingsBackend({ cli: "/bin/true", outputDir });
    await expect(
      backend.submit({
        descriptor,
        slots: { prompt: "portrait", seed: 9 },
        referenceImages: [
          {
            assetId: "anchor-1",
            role: "identity_anchor",
            b64Json: Buffer.from(PNG).toString("base64"),
          },
        ],
        timeoutMs: 5_000,
      }),
    ).rejects.toThrow(/one source_image/);
    expect(state.calls).toHaveLength(0);
  });

  it("surfaces a bounded non-zero CLI failure", async () => {
    state.exitCode = 2;
    const backend = new DrawThingsBackend({ cli: "/bin/false", outputDir });
    await expect(
      backend.submit({ descriptor, slots: { prompt: "portrait", seed: 9 }, timeoutMs: 5_000 }),
    ).rejects.toThrow(/draw-things-cli exited with 2.*draw-things-cli boom/s);
  });

  it("consumes cached results exactly once", async () => {
    const backend = new DrawThingsBackend({ cli: "/bin/true", outputDir });
    const handle = await backend.submit({
      descriptor,
      slots: { prompt: "portrait", seed: 9 },
      timeoutMs: 5_000,
    });
    await backend.poll(handle);
    await expect(backend.poll(handle)).rejects.toThrow(/no cached result/);
  });

  it("aborts a CLI process that exceeds the job timeout", async () => {
    state.hang = true;
    const backend = new DrawThingsBackend({ cli: "/bin/false", outputDir });
    await expect(
      backend.submit({ descriptor, slots: { prompt: "portrait", seed: 9 }, timeoutMs: 5 }),
    ).rejects.toThrow(/timed out after 5ms/);
  });
});

function valueAfter(args: string[], flag: string) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}
