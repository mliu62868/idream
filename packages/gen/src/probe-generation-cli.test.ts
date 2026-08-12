import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

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
      seconds: 4,
      terminal: {
        outcome: "succeeded",
        assets: 1,
        error: null,
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
