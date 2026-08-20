import path from "node:path";
import { fileURLToPath } from "node:url";

export const LEGACY_MEMORY_IMPORT_USAGE = [
  "Usage: bun run memory:import-legacy --user-id <id> --character-id <id>",
  "  --probe-file <path> [--dry-run|--apply]",
].join("\n");

export const MEMORY_CUTOVER_AUDIT_USAGE = "Usage: bun run memory:cutover-audit [--help]";

export interface LegacyMemoryImportCliInput {
  userId: string;
  characterId: string;
  probeFile: string;
  dryRun: boolean;
}

export function isLegacyMemoryImportHelp(argv: readonly string[]): boolean {
  return argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h");
}

export function parseLegacyMemoryImportArgs(
  argv: readonly string[],
): LegacyMemoryImportCliInput {
  let userId = "";
  let characterId = "";
  let probeFile = "";
  let dryRun = true;
  let explicitDryRun = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--user-id" || argument === "--character-id" || argument === "--probe-file") {
      const value = argv[index + 1]?.trim();
      if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);
      if (argument === "--user-id") userId = value;
      else if (argument === "--character-id") characterId = value;
      else probeFile = value;
      index += 1;
      continue;
    }
    if (argument === "--apply") {
      if (explicitDryRun) throw new Error("--apply and --dry-run are mutually exclusive");
      dryRun = false;
      continue;
    }
    if (argument === "--dry-run") {
      if (!dryRun) throw new Error("--apply and --dry-run are mutually exclusive");
      explicitDryRun = true;
      continue;
    }
    throw new Error(`unknown argument: ${argument}`);
  }
  if (!userId) throw new Error("--user-id is required");
  if (!characterId) throw new Error("--character-id is required");
  if (!probeFile) throw new Error("--probe-file is required");
  return { userId, characterId, probeFile, dryRun };
}

export function parseMemoryCutoverAuditArgs(argv: readonly string[]): { help: boolean } {
  if (argv.length === 0) return { help: false };
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
    return { help: true };
  }
  throw new Error(`unknown argument: ${argv[0] ?? ""}`);
}

async function main(): Promise<void> {
  const [command, ...argv] = process.argv.slice(2);
  if (command === "import-legacy") {
    if (isLegacyMemoryImportHelp(argv)) {
      process.stdout.write(`${LEGACY_MEMORY_IMPORT_USAGE}\n`);
      return;
    }
    const input = parseLegacyMemoryImportArgs(argv);
    const { runLegacyMemoryImportCli } = await import("./legacy-memory-import.js");
    await runLegacyMemoryImportCli(input);
    return;
  }
  if (command === "cutover-audit") {
    const args = parseMemoryCutoverAuditArgs(argv);
    if (args.help) {
      process.stdout.write(`${MEMORY_CUTOVER_AUDIT_USAGE}\n`);
      return;
    }
    const { runMemoryCutoverAuditCli } = await import("./memory-cutover-audit.js");
    await runMemoryCutoverAuditCli();
    return;
  }
  throw new Error(`unknown memory command: ${command ?? ""}`);
}

const entrypoint = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (fileURLToPath(import.meta.url) === entrypoint) await main();
