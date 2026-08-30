import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { env } from "./env";

const originalWorkflowDir = process.env.GEN_WORKFLOW_DIR;
const originalVideoTimeout = process.env.GEN_VIDEO_TIMEOUT_MS;
const originalMainWebUrl = process.env.MAIN_WEB_URL;
const originalComfyUiApiUrl = process.env.COMFYUI_API_URL;
const originalComfyUiImageApiUrl = process.env.COMFYUI_IMAGE_API_URL;
const originalComfyUiVideoApiUrl = process.env.COMFYUI_VIDEO_API_URL;
const originalComfyUiH3ApiUrl = process.env.COMFYUI_H3_API_URL;

afterEach(() => {
  if (originalWorkflowDir === undefined) {
    delete process.env.GEN_WORKFLOW_DIR;
  } else {
    process.env.GEN_WORKFLOW_DIR = originalWorkflowDir;
  }
  if (originalVideoTimeout === undefined) {
    delete process.env.GEN_VIDEO_TIMEOUT_MS;
  } else {
    process.env.GEN_VIDEO_TIMEOUT_MS = originalVideoTimeout;
  }
  if (originalMainWebUrl === undefined) {
    delete process.env.MAIN_WEB_URL;
  } else {
    process.env.MAIN_WEB_URL = originalMainWebUrl;
  }
  for (const [name, value] of [
    ["COMFYUI_API_URL", originalComfyUiApiUrl],
    ["COMFYUI_IMAGE_API_URL", originalComfyUiImageApiUrl],
    ["COMFYUI_VIDEO_API_URL", originalComfyUiVideoApiUrl],
    ["COMFYUI_H3_API_URL", originalComfyUiH3ApiUrl],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("generation environment", () => {
  it("resolves the bundled workflow directory independently of process cwd", async () => {
    delete process.env.GEN_WORKFLOW_DIR;

    expect((await stat(env.GEN_WORKFLOW_DIR)).isDirectory()).toBe(true);
  });

  it("fails fast when the video timeout is not a positive integer", () => {
    process.env.GEN_VIDEO_TIMEOUT_MS = "not-a-timeout";

    expect(() => env.VIDEO_TIMEOUT_MS).toThrow(
      "GEN_VIDEO_TIMEOUT_MS must be a positive integer",
    );
  });

  it("routes image and video to isolated ComfyUI runners by default", () => {
    delete process.env.COMFYUI_API_URL;
    delete process.env.COMFYUI_IMAGE_API_URL;
    delete process.env.COMFYUI_VIDEO_API_URL;
    delete process.env.COMFYUI_H3_API_URL;

    expect(env.COMFYUI_IMAGE_API_URL).toBe("http://127.0.0.1:8189");
    expect(env.COMFYUI_VIDEO_API_URL).toBe("http://127.0.0.1:8188");
    expect(env.COMFYUI_H3_API_URL).toBe("http://127.0.0.1:8190");
  });

  it("allows modality-specific URLs to override the shared compatibility URL", () => {
    process.env.COMFYUI_API_URL = "http://127.0.0.1:9000";
    process.env.COMFYUI_IMAGE_API_URL = "http://127.0.0.1:9001";
    process.env.COMFYUI_VIDEO_API_URL = "http://127.0.0.1:9002";
    process.env.COMFYUI_H3_API_URL = "http://127.0.0.1:9003";

    expect(env.COMFYUI_IMAGE_API_URL).toBe("http://127.0.0.1:9001");
    expect(env.COMFYUI_VIDEO_API_URL).toBe("http://127.0.0.1:9002");
    expect(env.COMFYUI_H3_API_URL).toBe("http://127.0.0.1:9003");
  });
});

// SPEC: env.ts is the only place in gen that decides what an environment
// variable means.
// INTENT: preflight.ts resolved COMFYUI_API_URL with an extra `?? COMFYUI_URL`
// hop that env.ts does not have, so it could probe one ComfyUI while the worker
// generated against another — green report, unverified runner. The class matters
// more than that one variable, so this is a SET assertion over the whole source
// tree rather than a blacklist of names already known to have drifted: any new
// `process.env.X` read in gen, for any X env.ts owns, fails here.
describe("gen environment ownership", () => {
  const DELIBERATE_RAW_READS: Readonly<Record<string, readonly string[]>> = {};

  async function sourceFiles(dir: string): Promise<string[]> {
    const found: string[] = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) found.push(...(await sourceFiles(full)));
      else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
        found.push(full);
      }
    }
    return found;
  }

  it("keeps every variable env.ts owns out of the rest of gen/src", async () => {
    const root = path.dirname(fileURLToPath(import.meta.url));
    const envSource = await readFile(path.join(root, "env.ts"), "utf8");
    const owned = new Set(
      [...envSource.matchAll(/process\.env\.([A-Z][A-Z_0-9]*)/g)].map((m) => m[1]),
    );
    // Self-check: a regex that stopped matching would make the scan below pass
    // by scanning nothing.
    expect(owned.size).toBeGreaterThan(20);

    const files = (await sourceFiles(root)).filter(
      (file) => path.relative(root, file) !== "env.ts",
    );
    expect(files.length).toBeGreaterThan(15);

    const offenders: string[] = [];
    for (const file of files) {
      const relative = path.relative(root, file);
      const allowed = new Set(DELIBERATE_RAW_READS[path.basename(file)] ?? []);
      const source = await readFile(file, "utf8");
      // Group 2 is non-empty only for assignments (`= v`, `??= v`); those set
      // config for a child process rather than deciding what it means.
      for (const [, name, assignment] of source.matchAll(
        /process\.env\.([A-Z][A-Z_0-9]*)\s*(\?\?=|=(?!=)|)/g,
      )) {
        if (assignment) continue;
        if (!owned.has(name) || allowed.has(name)) continue;
        offenders.push(`${relative}: process.env.${name}`);
      }
    }

    expect(offenders).toEqual([]);
  });
});
