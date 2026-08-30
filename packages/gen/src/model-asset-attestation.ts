import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { access, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type PinnedModelAsset = {
  readonly path: string;
  readonly sha256: string;
};

export async function sha256File(filePath: string) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    digest.update(chunk);
  }
  return digest.digest("hex");
}

// INVARIANT: production recipe metadata is not proof of the bytes loaded by
// ComfyUI. Attestation resolves every pin inside the configured model root and
// fails closed before workers receive traffic.
export async function attestPinnedModelAssets(input: {
  readonly modelRoot: string;
  readonly assets: readonly PinnedModelAsset[];
}) {
  const root = path.resolve(input.modelRoot);
  const problems: string[] = [];

  for (const asset of input.assets) {
    const filePath = path.resolve(root, asset.path);
    const relative = path.relative(root, filePath);
    if (
      relative === "" ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      problems.push(`${asset.path} escapes the configured model root`);
      continue;
    }

    let actual: string;
    try {
      actual = await sha256File(filePath);
    } catch (error) {
      problems.push(`${asset.path} cannot be read: ${String(error)}`);
      continue;
    }
    if (actual !== asset.sha256) {
      problems.push(
        `${asset.path} SHA-256 is ${actual}, expected ${asset.sha256}`,
      );
    }
  }

  return { checked: input.assets.length, problems };
}

type RuntimeCommand = (
  command: string,
  args: readonly string[],
) => Promise<string>;

// INVARIANT: hashing a similarly named local file is insufficient. The probe
// must prove that the selected ComfyUI runner resolves each pinned
// relative path uniquely from the same COMFYUI_MODEL_ROOT.
export async function attestLocalComfyUiModelRoot(
  input: {
    readonly apiUrl: string;
    readonly assetPaths: readonly string[];
    readonly modelRoot: string;
  },
  dependencies: {
    readonly runCommand?: RuntimeCommand;
    readonly readTextFile?: (filePath: string) => Promise<string>;
    readonly resolveRealPath?: (filePath: string) => Promise<string>;
    readonly fileExists?: (filePath: string) => Promise<boolean>;
  } = {},
) {
  const target = new URL(input.apiUrl);
  if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(target.hostname)) {
    throw new Error(
      "Exact ComfyUI model-byte evidence requires the launch probe to run on the target runtime host",
    );
  }
  const port = target.port || (target.protocol === "https:" ? "443" : "80");
  const runCommand = dependencies.runCommand ?? systemCommand;
  const listenerPid = (await runCommand("lsof", [
    "-nP",
    `-iTCP:${port}`,
    "-sTCP:LISTEN",
    "-t",
  ]))
    .split(/\s+/)
    .map((value) => Number(value))
    .find((value) => Number.isInteger(value) && value > 0);
  if (!listenerPid) {
    throw new Error(`No local ComfyUI listener owns ${target.host}`);
  }

  const command = (await runCommand("ps", [
    "-p",
    String(listenerPid),
    "-o",
    "command=",
  ])).trim();
  const runtimeCwd = (await runCommand("lsof", [
    "-a",
    "-p",
    String(listenerPid),
    "-d",
    "cwd",
    "-Fn",
  ]))
    .split("\n")
    .find((line) => line.startsWith("n"))
    ?.slice(1)
    .trim();
  if (!runtimeCwd) {
    throw new Error("ComfyUI listener cwd could not be attested");
  }
  const configPath = commandLineValue(command, "--extra-model-paths-config");
  if (!configPath) {
    throw new Error(
      "ComfyUI listener does not declare --extra-model-paths-config",
    );
  }

  const readTextFile = dependencies.readTextFile ?? (async (filePath: string) =>
    readFile(filePath, "utf8"));
  const resolveRealPath = dependencies.resolveRealPath ?? realpath;
  const fileExists = dependencies.fileExists ?? (async (filePath: string) => {
    try {
      await access(filePath);
      return true;
    } catch {
      return false;
    }
  });
  const configuredRoots = modelRootsFromConfig(
    await readTextFile(configPath),
    path.dirname(configPath),
  );
  const expectedModelRoot = await resolveRealPath(input.modelRoot);
  const candidateRoots = await uniqueRealPaths(
    [...configuredRoots, path.join(runtimeCwd, "models")],
    resolveRealPath,
  );
  if (!candidateRoots.includes(expectedModelRoot)) {
    throw new Error(
      `COMFYUI_MODEL_ROOT ${expectedModelRoot} is not configured on the target ComfyUI listener`,
    );
  }

  const assetBindings: Array<{ path: string; runtimePath: string }> = [];
  for (const assetPath of input.assetPaths) {
    const matches: string[] = [];
    for (const root of candidateRoots) {
      const candidate = path.join(root, assetPath);
      if (await fileExists(candidate)) matches.push(candidate);
    }
    const expectedPath = path.join(expectedModelRoot, assetPath);
    if (matches.length !== 1 || matches[0] !== expectedPath) {
      throw new Error(
        `ComfyUI model ${assetPath} must resolve uniquely from COMFYUI_MODEL_ROOT; observed ${matches.join(", ") || "no runtime path"}`,
      );
    }
    assetBindings.push({ path: assetPath, runtimePath: expectedPath });
  }

  return {
    authority: "local_listener_process" as const,
    backendTarget: target.toString(),
    listenerPid,
    processCommandSha256: createHash("sha256").update(command).digest("hex"),
    expectedModelRoot,
    configuredModelRoots: candidateRoots,
    assetBindings,
  };
}

async function systemCommand(command: string, args: readonly string[]) {
  const result = await execFileAsync(command, [...args], { encoding: "utf8" });
  return String(result.stdout);
}

function commandLineValue(command: string, flag: string) {
  const marker = `${flag} `;
  const start = command.indexOf(marker);
  if (start < 0) return null;
  const rest = command.slice(start + marker.length);
  const nextFlag = rest.search(/\s--[a-z0-9-]+(?:\s|$)/i);
  return rest.slice(0, nextFlag < 0 ? undefined : nextFlag).trim().replace(/^['"]|['"]$/g, "");
}

function modelRootsFromConfig(body: string, configDirectory: string) {
  const roots: string[] = [];
  for (const match of body.matchAll(/^\s*base_path:\s*(.+?)\s*$/gm)) {
    const raw = match[1]?.trim().replace(/^['"]|['"]$/g, "");
    if (!raw) continue;
    roots.push(path.isAbsolute(raw) ? raw : path.resolve(configDirectory, raw));
  }
  return roots;
}

async function uniqueRealPaths(
  roots: readonly string[],
  resolveRealPath: (filePath: string) => Promise<string>,
) {
  const resolved = new Set<string>();
  for (const root of roots) {
    try {
      resolved.add(await resolveRealPath(root));
    } catch {
      // Missing optional roots cannot participate in ComfyUI model resolution.
    }
  }
  return [...resolved];
}
