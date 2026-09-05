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

  it.each(["single", "multiple", "repeated", "equals", "relative"] as const)("binds every %s config path from listener argv and rejects duplicates", async (kind) => {
    const root = await mkdtemp(path.join(tmpdir(), "idream-model-runtime-"));
    temporaryDirectories.push(root);
    const modelRoot = path.join(root, "shared models");
    const runtimeCwd = path.join(root, "ComfyUI");
    const defaultRoot = path.join(runtimeCwd, "models");
    const assetPath = "diffusion_models/model.safetensors";
    const configPath = path.join(root, "shared model paths.yaml");
    const desktopConfig = path.join(root, "Application Support", "Comfy Desktop", "model paths.yaml");
    const desktopRoot = path.join(root, "desktop models");
    await mkdir(path.dirname(path.join(modelRoot, assetPath)), { recursive: true });
    await mkdir(path.dirname(path.join(defaultRoot, assetPath)), { recursive: true });
    await mkdir(path.dirname(desktopConfig), { recursive: true });
    await mkdir(path.dirname(path.join(desktopRoot, assetPath)), { recursive: true });
    await writeFile(path.join(modelRoot, assetPath), "authorized bytes");
    await writeFile(configPath, `comfy.desktop:\n  base_path: '${modelRoot}'\n`);
    await writeFile(desktopConfig, `comfy.desktop:\n  base_path: '${desktopRoot}'\n`);
    const configArgs = kind === "single" ? ["--extra-model-paths-config", configPath]
      : kind === "multiple" ? ["--extra-model-paths-config", desktopConfig, configPath]
        : kind === "repeated" ? ["--extra-model-paths-config", desktopConfig, "--extra-model-paths-config", configPath]
          : kind === "equals" ? [`--extra-model-paths-config=${desktopConfig}`, `--extra-model-paths-config=${configPath}`]
            : ["--extra-model-paths-config", path.relative(runtimeCwd, desktopConfig), path.relative(runtimeCwd, configPath)];
    const argv = ["python", "main.py", "--port", "8188", ...configArgs, "--output-directory", "/tmp/output"];
    const runCommand = async (command: string, args: readonly string[]) => {
      if (command === "ps") {
        return `${argv.join(" ")}\n`;
      }
      if (command === "lsof" && args.includes("-iTCP:8188")) return "123\n";
      if (command === "lsof" && args.includes("cwd")) return `p123\nfcwd\nn${runtimeCwd}\n`;
      throw new Error(`unexpected command ${command} ${args.join(" ")}`);
    };
    const readProcessArgv = async () => argv;
    const realModelRoot = await realpath(modelRoot);

    await expect(attestLocalComfyUiModelRoot({
      apiUrl: "http://127.0.0.1:8188",
      assetPaths: [assetPath],
      modelRoot,
    }, { runCommand, readProcessArgv })).resolves.toMatchObject({
      authority: "local_listener_process",
      backendTarget: "http://127.0.0.1:8188/",
      listenerPid: 123,
      expectedModelRoot: realModelRoot,
      assetBindings: [{
        path: assetPath,
        runtimePath: path.join(realModelRoot, assetPath),
      }],
    });

    if (kind !== "single") {
      await writeFile(path.join(desktopRoot, assetPath), "shadow bytes in another config");
      await expect(attestLocalComfyUiModelRoot({
        apiUrl: "http://127.0.0.1:8188",
        assetPaths: [assetPath],
        modelRoot,
      }, { runCommand, readProcessArgv })).rejects.toThrow("must resolve uniquely");
      await rm(path.join(desktopRoot, assetPath));
    }

    await writeFile(path.join(defaultRoot, assetPath), "shadow bytes");
    await expect(attestLocalComfyUiModelRoot({
      apiUrl: "http://127.0.0.1:8188",
      assetPaths: [assetPath],
      modelRoot,
    }, { runCommand, readProcessArgv })).rejects.toThrow("must resolve uniquely");
  });

  it.each([
    [[], "does not declare --extra-model-paths-config"],
    [["--extra-model-paths-config"], "requires at least one config path"],
    [["--extra-model-paths-config", "--port", "8188"], "requires at least one config path"],
    [["--extra-model-paths-config", ""], "requires at least one config path"],
    [["--extra-model-paths-config="], "requires at least one config path"],
    [["--extra-model-paths-config", "/valid.yaml", "/missing.yaml"], "missing config must fail"],
  ] as const)("fails closed for invalid or unreadable config arguments: %j", async (configArgs, message) => {
    await expect(attestLocalComfyUiModelRoot({
      apiUrl: "http://127.0.0.1:8188",
      assetPaths: ["diffusion_models/model.safetensors"],
      modelRoot: "/models",
    }, {
      runCommand: async (command, args) => command === "ps"
        ? "python main.py"
        : args.includes("cwd") ? "n/runtime" : "123",
      readProcessArgv: async () => ["python", "main.py", ...configArgs],
      readTextFile: async (file) => {
        if (file === "/valid.yaml") return "runtime:\n  base_path: /models\n";
        throw new Error("missing config must fail");
      },
    })).rejects.toThrow(message);
  });
});
