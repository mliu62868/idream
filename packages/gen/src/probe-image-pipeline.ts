import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { GenerationTerminalRecordIngest } from "@idream/shared/contracts";
import { env } from "./env";
import { processImageGenerate } from "./pipeline";

type ProbeOptions = {
  prompt: string;
  negativePrompt: string | null;
  count: number;
  model: string;
  orientation: string;
  report: string | null;
};

function readArg(name: string) {
  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function readOptions(): ProbeOptions {
  const count = Number.parseInt(readArg("count") ?? "1", 10);
  return {
    prompt: readArg("prompt") ?? "high quality portrait, cinematic lighting",
    negativePrompt: readArg("negative-prompt") ?? null,
    count: Number.isFinite(count) ? Math.max(1, Math.min(count, 4)) : 1,
    model: readArg("model") ?? env.PIPELINE_IMAGE_MODEL_DEFAULT,
    orientation: readArg("orientation") ?? "1:1",
    report: readArg("report") ?? process.env.PIPELINE_IMAGE_PROBE_REPORT ?? null,
  };
}

async function main() {
  const options = readOptions();
  const startedAt = Date.now();
  const generationJobId = `probe_${randomUUID()}`;
  const terminalIngests: GenerationTerminalRecordIngest[] = [];

  await processImageGenerate(
    {
      version: 1,
      kind: "image",
      requestId: `req_${generationJobId}`,
      generationJobId,
      userId: "probe-user",
      characterId: null,
      prompt: options.prompt,
      negativePrompt: options.negativePrompt,
      controls: { source: "probe-image-pipeline" },
      presetIds: [],
      orientation: options.orientation,
      count: options.count,
      seed: `probe-${Date.now()}`,
      model: options.model,
      outputPrefix: `probe/${generationJobId}/`,
    },
    {
      acknowledgeTerminalRecord: async (input) => {
        terminalIngests.push(input);
      },
      recordTransportExecution: async () => undefined,
      attemptsMade: 0,
      maxAttempts: 1,
    },
  );

  const terminalIngest = terminalIngests[0];
  const terminalRecord = terminalIngest?.terminalRecord;
  const ok = terminalRecord?.outcome === "succeeded";
  const assets = terminalRecord?.outcome === "succeeded"
    ? terminalRecord.assets.length
    : 0;
  const error = terminalRecord?.outcome === "failed" || terminalRecord?.outcome === "unknown"
    ? terminalRecord.error
    : terminalRecord?.outcome === "blocked"
      ? terminalRecord.block
      : null;
  const report = {
    ok,
    checkedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    provider: env.IMAGE_PROVIDER,
    pipelineUrl: env.PIPELINE_API_URL ?? null,
    model: options.model,
    orientation: options.orientation,
    count: options.count,
    blobRoot: env.BLOB_ROOT,
    generationJobId,
    terminal: terminalIngest
      ? {
          ref: terminalIngest.terminalRecordRef,
          checksum: terminalIngest.terminalRecordChecksum,
          outcome: terminalRecord?.outcome,
          assets,
          error,
        }
      : null,
  };

  if (options.report) {
    const reportPath = resolveWorkspacePath(options.report);
    await mkdir(path.dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  }

  process.stdout.write(
    `${JSON.stringify(report, null, 2)}\n`,
  );

  if (!ok) process.exitCode = 1;
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});

function resolveWorkspacePath(filePath: string) {
  if (path.isAbsolute(filePath)) return filePath;
  return path.resolve(workspaceRoot(), filePath);
}

function workspaceRoot() {
  let current = process.cwd();
  while (true) {
    if (
      existsSync(path.join(current, "package.json")) &&
      (existsSync(path.join(current, "turbo.json")) ||
        existsSync(path.join(current, "bun.lock")))
    ) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) return process.cwd();
    current = parent;
  }
}
