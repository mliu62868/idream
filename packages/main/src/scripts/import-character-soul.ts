import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { prisma } from "@/server/lib/db";
import { importRepositorySoul } from "@/server/modules/admin-v2/characters/soul-import";

function valueAfter(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

export async function runCharacterSoulImportCli(args = process.argv.slice(2)) {
  const fileArg = valueAfter(args, "--file");
  if (!fileArg) throw new Error("Usage: --file <reviewed-soul.json> [--apply --actor-id <id> --request-id <id>]");
  const allowed = new Set(["--file", "--apply", "--actor-id", "--actor-role", "--request-id"]);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!allowed.has(arg)) throw new Error(`Unknown argument: ${arg}`);
    if (arg !== "--apply") index += 1;
  }
  const absoluteFile = path.resolve(fileArg);
  const bytes = await readFile(absoluteFile);
  const document = JSON.parse(bytes.toString("utf8")) as unknown;
  const sourceId = `repo:${path.relative(process.cwd(), absoluteFile)}:${createHash("sha256").update(bytes).digest("hex")}`;
  const result = await importRepositorySoul({
    db: prisma,
    document,
    apply: args.includes("--apply"),
    actorId: valueAfter(args, "--actor-id"),
    actorRole: valueAfter(args, "--actor-role"),
    requestId: valueAfter(args, "--request-id"),
    sourceId,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCharacterSoulImportCli()
    .then(() => prisma.$disconnect())
    .catch(async (error) => {
      process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
      await prisma.$disconnect();
      process.exitCode = 1;
    });
}
