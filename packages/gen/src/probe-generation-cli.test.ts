import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { sha256File } from "./model-asset-attestation";
import { videoProbeBackendTarget } from "./probe-video-pipeline";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const tsxCli = path.join(
  repoRoot,
  "packages/gen/node_modules/tsx/dist/cli.mjs",
);
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("generation launch probe CLIs", () => {
  it("attests MiniMax H3 against its dedicated listener", () => {
    const targets = {
      video: "http://127.0.0.1:8188",
      h3: "http://127.0.0.1:8190",
      drawThings: "draw-things-cli",
    };

    expect(videoProbeBackendTarget({
      backendKind: "comfyui",
      workflowKey: "minimax-h3-redcraft-i2v",
      capabilities: ["video", "audio"],
    }, targets)).toBe(targets.h3);
    expect(videoProbeBackendTarget({
      backendKind: "comfyui",
      workflowKey: "redgraft-ltx25-i2v",
      capabilities: ["video", "audio"],
    }, targets)).toBe(targets.video);
  });

  it("hashes model assets through a file stream", async () => {
    const directory = temporaryDirectory();
    const assetPath = path.join(directory, "model.safetensors");
    writeFileSync(assetPath, "streamed model bytes");

    expect(await sha256File(assetPath)).toBe(
      "6a2f2277fac614b3a8ace8c7355c970cb055f15987c04c041dc3610a2896c197",
    );
  });

  it("fails preflight when backend production recipe bytes are absent", async () => {
    const directory = temporaryDirectory();
    const server = spawn(
      process.execPath,
      [
        "-e",
        'const http=require("node:http");const server=http.createServer((request,response)=>{if(request.url==="/system_stats"){response.writeHead(200,{"content-type":"application/json"});response.end("{}");return;}response.writeHead(404);response.end();});server.listen(0,"127.0.0.1",()=>console.log(server.address().port));',
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    try {
      const [chunk] = await once(server.stdout!, "data");
      const port = Number(String(chunk).trim());
      const result = runProbe("preflight.ts", [], {
        GEN_VIDEO_PROVIDER: "backend",
        COMFYUI_API_URL: `http://127.0.0.1:${port}`,
        COMFYUI_MODEL_ROOT: path.join(directory, "models"),
        GEN_WORKFLOW_DIR: directory,
        GEN_FFPROBE_BIN: "/usr/bin/true",
        GEN_FFMPEG_BIN: "/usr/bin/true",
      });

      expect(result.status).toBe(1);
      expect(result.stdout).toContain("FAIL  (video model bytes)");
      expect(result.stdout).toContain("9 pinned model bytes checked");
    } finally {
      const exited = once(server, "exit");
      server.kill();
      await exited;
    }
  });

  it("keeps the image probe aligned with Attempt and immutable TerminalRecord contracts", () => {
    const directory = temporaryDirectory();
    const reportPath = path.join(directory, "image-report.json");
    const result = runProbe("probe-image-pipeline.ts", [
      "--model",
      "image-default",
      "--report",
      reportPath,
    ], {
      GEN_IMAGE_PROVIDER: "mock",
      GEN_BLOB_PROVIDER: "mock",
      BLOB_ROOT: path.join(directory, "blob"),
    });

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(readFileSync(reportPath, "utf8"))).toMatchObject({
      ok: true,
      provider: "mock",
      blobAuthority: {
        provider: "mock",
        endpoint: null,
        bucket: null,
        root: path.join(directory, "blob"),
      },
      terminal: {
        outcome: "succeeded",
        assets: 1,
        error: null,
      },
    });
  });

  it("keeps the video probe aligned with its source pin and immutable TerminalRecord", () => {
    const directory = temporaryDirectory();
    const reportPath = path.join(directory, "video-report.json");
    const referencePath = path.join(
      repoRoot,
      "packages/main/public/images/ourdream/card-alexa-reeves.webp",
    );
    const result = runProbe("probe-video-pipeline.ts", [
      "--reference",
      referencePath,
      "--model",
      "video-default",
      "--report",
      reportPath,
    ], {
      GEN_VIDEO_PROVIDER: "mock",
      GEN_BLOB_PROVIDER: "mock",
      BLOB_ROOT: path.join(directory, "blob"),
    });

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(readFileSync(reportPath, "utf8"))).toMatchObject({
      ok: true,
      provider: "mock",
      blobAuthority: {
        provider: "mock",
        endpoint: null,
        bucket: null,
        root: path.join(directory, "blob"),
      },
      seconds: 5,
      terminal: {
        outcome: "succeeded",
        assets: 1,
        error: null,
      },
    });
  });

  it("uses the MiniMax H3 five-second recipe when that workflow is probed", () => {
    const directory = temporaryDirectory();
    const reportPath = path.join(directory, "h3-video-report.json");
    const referencePath = path.join(
      repoRoot,
      "packages/main/public/images/ourdream/card-alexa-reeves.webp",
    );
    const result = runProbe("probe-video-pipeline.ts", [
      "--reference",
      referencePath,
      "--model",
      "minimax-h3-redcraft-i2v",
      "--seed",
      "h3-probe-seed-v1",
      "--report",
      reportPath,
    ], {
      GEN_VIDEO_PROVIDER: "mock",
      GEN_BLOB_PROVIDER: "mock",
      IDREAM_SOURCE_REVISION: "idream@h3-probe-test",
      BLOB_ROOT: path.join(directory, "blob"),
    });

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(readFileSync(reportPath, "utf8"))).toMatchObject({
      ok: true,
      model: "minimax-h3-redcraft-i2v",
      seconds: 5,
      seed: "h3-probe-seed-v1",
      sourceRevision: "idream@h3-probe-test",
      requestId: expect.stringMatching(/^req_probe_video_/),
      attemptId: expect.stringMatching(/^attempt_/),
      artifact: {
        key: expect.stringMatching(/video\.mp4$/),
        localPath: expect.stringMatching(/video\.mp4$/),
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        sizeBytes: expect.any(Number),
        verifiedVideo: null,
      },
      terminal: {
        sourceRevision: "idream@h3-probe-test",
        outcome: "succeeded",
        assets: 1,
        providerRequestId: null,
      },
    });
  });
});

function temporaryDirectory() {
  const directory = mkdtempSync(path.join(tmpdir(), "idream-gen-probe-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function runProbe(
  scriptName: string,
  args: readonly string[],
  env: Record<string, string>,
) {
  return spawnSync(
    process.execPath,
    [tsxCli, path.join(repoRoot, "packages/gen/src", scriptName), ...args],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        APP_ENV: "test",
        ...env,
      },
      encoding: "utf8",
    },
  );
}
