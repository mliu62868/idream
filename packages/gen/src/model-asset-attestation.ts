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
    readonly readProcessArgv?: (pid: number) => Promise<readonly string[]>;
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
  const argv = await (dependencies.readProcessArgv ?? readProcessArgv)(listenerPid);
  const configPaths = commandLineValues(argv, "--extra-model-paths-config");
  if (configPaths.length === 0) {
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
  const configuredRoots: string[] = [];
  for (const configuredPath of configPaths) {
    const configPath = path.resolve(runtimeCwd, configuredPath);
    configuredRoots.push(...modelRootsFromConfig(
      await readTextFile(configPath),
      path.dirname(configPath),
    ));
  }
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

async function readProcessArgv(pid: number): Promise<readonly string[]> {
  if (process.platform === "linux") {
    const raw = await readFile(`/proc/${pid}/cmdline`, "utf8");
    if (!raw.endsWith("\0")) throw new Error("ComfyUI listener argv is incomplete");
    return raw.slice(0, -1).split("\0");
  }
  if (process.platform !== "darwin") {
    throw new Error("ComfyUI listener argv attestation requires Linux or macOS");
  }
  // SPEC: ps flattens argv and loses boundaries around paths containing spaces.
  // Read the kernel's argc arguments only; never print the following environment.
  const raw = await systemCommand("python3", ["-I", "-S", "-c", String.raw`
import ctypes, json, struct, sys
libc = ctypes.CDLL(None, use_errno=True)
mib = (ctypes.c_int * 3)(1, 49, int(sys.argv[1]))  # CTL_KERN, KERN_PROCARGS2
size = ctypes.c_size_t(0)
if libc.sysctl(mib, 3, None, ctypes.byref(size), None, 0):
    raise OSError(ctypes.get_errno(), "Cannot read listener argv size")
buffer = ctypes.create_string_buffer(size.value)
if libc.sysctl(mib, 3, buffer, ctypes.byref(size), None, 0):
    raise OSError(ctypes.get_errno(), "Cannot read listener argv")
data = buffer.raw[:size.value]
argc = struct.unpack_from("i", data)[0]
if not 1 <= argc <= len(data):
    raise ValueError("Invalid listener argc")
cursor = data.index(b"\0", 4) + 1
while cursor < len(data) and data[cursor] == 0:
    cursor += 1
argv = []
for _ in range(argc):
    end = data.index(b"\0", cursor)
    argv.append(data[cursor:end].decode("utf-8"))
    cursor = end + 1
print(json.dumps(argv))
`, String(pid)]);
  const argv: unknown = JSON.parse(raw);
  if (!Array.isArray(argv) || argv.length === 0 || !argv.every((value) => typeof value === "string")) {
    throw new Error("ComfyUI listener argv could not be attested");
  }
  return argv;
}

function commandLineValues(argv: readonly string[], flag: string) {
  const values: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument.startsWith(`${flag}=`)) {
      const value = argument.slice(flag.length + 1);
      if (!value) throw new Error(`${flag} requires at least one config path`);
      values.push(value);
    } else if (argument === flag) {
      const start = values.length;
      while (index + 1 < argv.length && !argv[index + 1]!.startsWith("-")) {
        const value = argv[++index]!;
        if (!value) throw new Error(`${flag} requires at least one config path`);
        values.push(value);
      }
      if (values.length === start) throw new Error(`${flag} requires at least one config path`);
    }
  }
  return values;
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
