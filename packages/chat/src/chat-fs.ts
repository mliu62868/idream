// SPEC: The ONE module that touches the local file store (design §5, D1). Direct
// fs — no Store interface (YAGNI). To switch to shared storage/S3 later, change
// only this file. Layout (under CHAT_FS_ROOT, tenant-partitioned):
//   sessions/{userId}/{sessionId}.jsonl  agent execution trace (append-only)
//   mem/{userId}/{charId}/memory.md      long-term memory (atomic rewrite)
//   mem/{userId}/{charId}/relationship.md
//   mem/{userId}/global/boundaries.md
// INVARIANTS: append uses O_APPEND; whole-file updates use temp+rename (atomic);
// ids are sanitized so a crafted id can't escape the root (no path traversal).
import { appendFile, mkdir, readFile, rename, rm, readdir, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import { env } from "./env.js";

function root(): string {
  return env.CHAT_FS_ROOT;
}

/** Reject anything that could escape the tenant partition. */
function safeSegment(value: string): string {
  if (!value || value.includes("/") || value.includes("\\") || value.includes("..")) {
    throw new Error(`unsafe path segment: ${JSON.stringify(value)}`);
  }
  return value;
}

function abs(relParts: string[]): string {
  const safe = relParts.map(safeSegment);
  const full = path.resolve(root(), ...safe);
  // defense in depth: resolved path must stay under root
  const rootResolved = path.resolve(root());
  if (full !== rootResolved && !full.startsWith(rootResolved + path.sep)) {
    throw new Error("path escapes CHAT_FS_ROOT");
  }
  return full;
}

// ---- path builders ----------------------------------------------------------
export const chatFsPaths = {
  sessionLog: (userId: string, sessionId: string) => [
    "sessions",
    userId,
    `${safeSegment(sessionId)}.jsonl`,
  ],
  memory: (userId: string, charId: string) => ["mem", userId, charId, "memory.md"],
  relationship: (userId: string, charId: string) => ["mem", userId, charId, "relationship.md"],
  boundaries: (userId: string) => ["mem", userId, "global", "boundaries.md"],
  userPrefix: (userId: string) => [userId],
} as const;

// ---- primitive ops ----------------------------------------------------------

/** Append one JSON line (or text line) to a file, creating parents. O_APPEND. */
export async function appendLine(relParts: string[], line: string): Promise<void> {
  const file = abs(relParts);
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, line.endsWith("\n") ? line : `${line}\n`, { encoding: "utf8", flag: "a" });
}

/** Read a whole file as utf8, or null if it does not exist. */
export async function readWhole(relParts: string[]): Promise<string | null> {
  try {
    return await readFile(abs(relParts), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Atomically replace a whole file (temp + rename), creating parents. */
export async function writeAtomic(relParts: string[], content: string): Promise<void> {
  const file = abs(relParts);
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${counter()}`;
  await writeFile(tmp, content, "utf8");
  await rename(tmp, file);
}

/** List relative file paths under a directory prefix (recursive). Empty if absent. */
export async function listPrefix(prefixParts: string[]): Promise<string[]> {
  const base = abs(prefixParts);
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else out.push(path.relative(root(), full));
    }
  }
  await walk(base);
  return out.sort();
}

/** Recursively delete everything under a prefix (privacy deletion). Idempotent. */
export async function deletePrefix(prefixParts: string[]): Promise<void> {
  await rm(abs(prefixParts), { recursive: true, force: true });
}

/** File size in bytes, or 0 if absent (for rolling/compaction thresholds). */
export async function fileSize(relParts: string[]): Promise<number> {
  try {
    return (await stat(abs(relParts))).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}

// Monotonic-ish suffix for temp files without Date.now()/random in hot loops.
let _c = 0;
function counter(): number {
  _c = (_c + 1) % Number.MAX_SAFE_INTEGER;
  return _c;
}
