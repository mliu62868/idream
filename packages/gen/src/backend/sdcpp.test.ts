import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { writeFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { workflowDescriptorSchema } from "./workflow";

// 2x2 PNG (checkerboard black/white) — same fixture as comfyui.test.ts. A true 1x1
// pixel would always trip assertGeneratedImageSanity's degenerate-image check
// (uniform luminance range 0), so this uses a valid, non-degenerate 2x2 image.
const PNG = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAE0lEQVR4nGNgYGD4//8/GDMwAAAp5AX71ZPZmwAAAABJRU5ErkJggg=="),
  (c) => c.charCodeAt(0),
);

// SPEC: state referenced inside the vi.mock factory must be created via vi.hoisted
// so it exists before the mocked "node:child_process" module is first resolved
// (which happens while this file's own static imports — including "./sdcpp" — are
// being evaluated, i.e. before the rest of this file's top-level code runs).
const state = vi.hoisted(() => ({
  calls: [] as Array<{ command: string; args: string[] }>,
  exitCode: 0,
}));

vi.mock("node:child_process", () => ({
  spawn: vi.fn((command: string, args: string[]) => {
    state.calls.push({ command, args });
    const child = new EventEmitter() as EventEmitter & Pick<ChildProcess, "stdout" | "stderr">;
    child.stdout = new EventEmitter() as ChildProcess["stdout"];
    child.stderr = new EventEmitter() as ChildProcess["stderr"];
    queueMicrotask(() => {
      void (async () => {
        if (state.exitCode === 0) {
          const outputIndex = args.indexOf("--output");
          const outputPath = outputIndex >= 0 ? args[outputIndex + 1] : undefined;
          if (outputPath) await writeFile(outputPath, PNG);
        } else {
          child.stderr?.emit("data", Buffer.from("sd-cli boom"));
        }
        child.emit("close", state.exitCode);
      })();
    });
    return child as unknown as ChildProcess;
  }),
}));

import { SdcppBackend } from "./sdcpp";

const descriptor = workflowDescriptorSchema.parse({
  workflowKey: "sd-t2i",
  modelId: "z-turbo",
  backendKind: "sdcpp",
  version: 1,
  capabilities: ["textToImage"],
  apiPrompt: {},
  inputs: [
    { key: "prompt", type: "text", target: { argFlag: "--prompt" } },
    { key: "steps", type: "int", target: { argFlag: "--steps" }, default: 8 },
  ],
});

describe("SdcppBackend", () => {
  let outputDir: string;

  beforeEach(async () => {
    state.calls.length = 0;
    state.exitCode = 0;
    outputDir = await mkdtemp(path.join(tmpdir(), "sdcpp-backend-test-"));
  });

  afterEach(async () => {
    await rm(outputDir, { recursive: true, force: true });
  });

  it("submits with bound sd-cli flags then poll returns the generated asset", async () => {
    const backend = new SdcppBackend({ cli: "/usr/local/bin/sd-cli", outputDir });
    const handle = await backend.submit({
      descriptor,
      slots: { prompt: "a cat", steps: 12 },
      timeoutMs: 5_000,
    });

    expect(state.calls).toHaveLength(1);
    const [{ command, args }] = state.calls;
    expect(command).toBe("/usr/local/bin/sd-cli");
    // argv contains the flags bindSdcppArgs produces from the descriptor + slots
    expect(args).toEqual(expect.arrayContaining(["--prompt", "a cat", "--steps", "12"]));

    const result = await backend.poll(handle);
    expect(result.assets).toHaveLength(1);
    expect(result.assets[0].body.byteLength).toBeGreaterThan(0);
    expect(result.assets[0].contentType).toBe("image/png");
    expect(result.assets[0].width).toBe(2);
    expect(result.assets[0].height).toBe(2);
  });

  it("poll throws once the cached result has already been consumed", async () => {
    const backend = new SdcppBackend({ cli: "/usr/local/bin/sd-cli", outputDir });
    const handle = await backend.submit({ descriptor, slots: { prompt: "a cat" }, timeoutMs: 5_000 });
    await backend.poll(handle);
    await expect(backend.poll(handle)).rejects.toThrow(/no cached result/);
  });

  it("submit rejects when sd-cli exits non-zero", async () => {
    state.exitCode = 1;
    const backend = new SdcppBackend({ cli: "/usr/local/bin/sd-cli", outputDir });
    await expect(
      backend.submit({ descriptor, slots: { prompt: "a cat" }, timeoutMs: 5_000 }),
    ).rejects.toThrow(/sd-cli exited with 1/);
  });

  it("health() resolves ok:true for an executable cli and ok:false otherwise", async () => {
    const okBackend = new SdcppBackend({ cli: "/bin/ls", outputDir });
    await expect(okBackend.health()).resolves.toEqual({ ok: true });

    const badBackend = new SdcppBackend({ cli: "/no/such/sd-cli-binary", outputDir });
    const health = await badBackend.health();
    expect(health.ok).toBe(false);
    expect(health.detail).toBeTruthy();
  });
});
