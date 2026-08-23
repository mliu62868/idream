import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  attestLocalComfyUiModelRoot,
  attestPinnedModelAssets,
} from "./model-asset-attestation";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("pinned model asset attestation", () => {
  it("accepts exact bytes and reports mismatches and missing assets", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "idream-model-attestation-"));
    temporaryDirectories.push(root);
    await writeFile(path.join(root, "exact.bin"), "exact model bytes");
    await writeFile(path.join(root, "changed.bin"), "changed model bytes");

    const result = await attestPinnedModelAssets({
      modelRoot: root,
      assets: [
        {
          path: "exact.bin",
          sha256:
            "f8ee3ff497d6e851aaaf1be3c1b7013665dc4ff1288dfb04bda5ce98645d4043",
        },
        { path: "changed.bin", sha256: "0".repeat(64) },
        { path: "missing.bin", sha256: "1".repeat(64) },
      ],
    });

    expect(result.checked).toBe(3);
    expect(result.problems).toEqual([
      expect.stringContaining("changed.bin SHA-256"),
      expect.stringContaining("missing.bin cannot be read"),
    ]);
  });

  it("binds pinned paths to the local listener model root and rejects duplicates", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "idream-model-runtime-"));
    temporaryDirectories.push(root);
    const modelRoot = path.join(root, "shared models");
    const runtimeCwd = path.join(root, "ComfyUI");
    const defaultRoot = path.join(runtimeCwd, "models");
    const assetPath = "diffusion_models/model.safetensors";
    const configPath = path.join(root, "shared model paths.yaml");
    await mkdir(path.dirname(path.join(modelRoot, assetPath)), { recursive: true });
    await mkdir(path.dirname(path.join(defaultRoot, assetPath)), { recursive: true });
    await writeFile(path.join(modelRoot, assetPath), "authorized bytes");
    await writeFile(configPath, `comfy.desktop:\n  base_path: '${modelRoot}'\n`);
    const runCommand = async (command: string, args: readonly string[]) => {
      if (command === "ps") {
        return `python main.py --port 8188 --extra-model-paths-config ${configPath} --output-directory /tmp/output\n`;
      }
      if (command === "lsof" && args.includes("-iTCP:8188")) return "123\n";
      if (command === "lsof" && args.includes("cwd")) return `p123\nfcwd\nn${runtimeCwd}\n`;
      throw new Error(`unexpected command ${command} ${args.join(" ")}`);
    };
    const realModelRoot = await realpath(modelRoot);

    await expect(attestLocalComfyUiModelRoot({
      apiUrl: "http://127.0.0.1:8188",
      assetPaths: [assetPath],
      modelRoot,
    }, { runCommand })).resolves.toMatchObject({
      authority: "local_listener_process",
      backendTarget: "http://127.0.0.1:8188/",
      listenerPid: 123,
      expectedModelRoot: realModelRoot,
      assetBindings: [{
        path: assetPath,
        runtimePath: path.join(realModelRoot, assetPath),
      }],
    });

    await writeFile(path.join(defaultRoot, assetPath), "shadow bytes");
    await expect(attestLocalComfyUiModelRoot({
      apiUrl: "http://127.0.0.1:8188",
      assetPaths: [assetPath],
      modelRoot,
    }, { runCommand })).rejects.toThrow("must resolve uniquely");
  });
});
