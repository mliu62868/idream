import path from "node:path";
import { fileURLToPath } from "node:url";

export const MEMORY_CUTOVER_AUDIT_USAGE =
  "Usage: bun run memory:cutover-audit [--help]";

export function parseMemoryCutoverAuditArgs(
  argv: readonly string[],
): { help: boolean } {
  if (argv.length === 0) return { help: false };
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
    return { help: true };
  }
  throw new Error(`unknown argument: ${argv[0] ?? ""}`);
}

async function main(): Promise<void> {
  const [command, ...argv] = process.argv.slice(2);
  if (command !== "cutover-audit") {
    throw new Error(`unknown memory command: ${command ?? ""}`);
  }
  const args = parseMemoryCutoverAuditArgs(argv);
  if (args.help) {
    process.stdout.write(`${MEMORY_CUTOVER_AUDIT_USAGE}\n`);
    return;
  }
  const { runMemoryCutoverAuditCli } = await import("./memory-cutover-audit.js");
  await runMemoryCutoverAuditCli();
}

const entrypoint = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (fileURLToPath(import.meta.url) === entrypoint) await main();
