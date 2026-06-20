// SPEC: User-facing long-term memory management over the file layer (PRD §8.2,
// §12). The companion's "what it remembers about me" surface: list / edit /
// delete the mem/*.md lines, and forget-by-source when a message is deleted.
// INTENT: pure file-layer (no PG) — memories are tenant-partitioned under
// mem/{userId}/, so reading only the caller's own prefix is the isolation.
// INVARIANTS: deletion lands in the AUTHORITY file (not just a filtered view);
// each line carries a stable id (explicit `mid:` or a content hash for legacy
// lines) so PATCH/DELETE by id is deterministic across reads.
import { createHash } from "node:crypto";
import path from "node:path";
import { env } from "./env.js";
import { listPrefix, readWhole, writeAtomic } from "./chat-fs.js";

export interface MemoryItem {
  id: string;
  characterId: string | null; // null = global scope (boundaries.md)
  type: string; // user_fact | preference | boundary | shared_event | note
  text: string;
  sourceMessageIds: string[];
  confidence: number | null;
}

interface ParsedLine extends MemoryItem {
  /** index of the raw line in the file (for in-place rewrite). */
  lineNo: number;
}

interface MemoryFile {
  charId: string; // directory segment under mem/{userId}/ ("global" for boundaries)
  relParts: string[]; // path parts for readWhole/writeAtomic
  raw: string;
  lines: string[];
}

// Only these files hold memory bullets; relationship.md is managed separately.
const MEMORY_FILES = new Set(["memory.md", "boundaries.md"]);

/** List the caller's memories, optionally scoped to one character (+ global). */
export async function listMemories(
  userId: string,
  characterId?: string,
): Promise<MemoryItem[]> {
  const files = await loadMemoryFiles(userId);
  const out: MemoryItem[] = [];
  for (const file of files) {
    if (characterId && file.charId !== characterId && file.charId !== "global") continue;
    for (const parsed of parseFile(file)) {
      const { lineNo: _drop, ...item } = parsed;
      void _drop;
      out.push(item);
    }
  }
  return out;
}

/** Edit a memory's text in place. Returns the updated item or null if not found. */
export async function updateMemory(
  userId: string,
  id: string,
  text: string,
): Promise<MemoryItem | null> {
  const clean = text.trim();
  if (!clean) return null;
  const files = await loadMemoryFiles(userId);
  for (const file of files) {
    const hit = parseFile(file).find((p) => p.id === id);
    if (!hit) continue;
    const updated: MemoryItem = { ...hit, text: clean, id };
    file.lines[hit.lineNo] = renderLine(updated);
    await writeAtomic(file.relParts, joinLines(file.lines));
    return updated;
  }
  return null;
}

/** Hard-delete a memory line. Returns true if a line was removed. */
export async function deleteMemory(userId: string, id: string): Promise<boolean> {
  const files = await loadMemoryFiles(userId);
  for (const file of files) {
    const hit = parseFile(file).find((p) => p.id === id);
    if (!hit) continue;
    file.lines.splice(hit.lineNo, 1);
    await writeAtomic(file.relParts, joinLines(file.lines));
    return true;
  }
  return false;
}

/**
 * Forget every memory line derived from any of `messageIds` (PRD §12: deleting a
 * message must clear its source linkage, not just filter retrieval). Best-effort
 * across all of the user's memory files. Returns the number of lines dropped.
 */
export async function forgetByMessageIds(
  userId: string,
  messageIds: string[],
): Promise<number> {
  if (messageIds.length === 0) return 0;
  const targets = new Set(messageIds);
  const files = await loadMemoryFiles(userId);
  let dropped = 0;
  for (const file of files) {
    const keep: string[] = [];
    let changed = false;
    for (let i = 0; i < file.lines.length; i++) {
      const parsed = parseLine(file.charId, file.lines[i], i);
      if (parsed && parsed.sourceMessageIds.some((s) => targets.has(s))) {
        dropped++;
        changed = true;
        continue;
      }
      keep.push(file.lines[i]);
    }
    if (changed) await writeAtomic(file.relParts, joinLines(keep));
  }
  return dropped;
}

// ---- internals --------------------------------------------------------------

async function loadMemoryFiles(userId: string): Promise<MemoryFile[]> {
  const rels = await listPrefix(["mem", userId]);
  const out: MemoryFile[] = [];
  for (const rel of rels) {
    const parts = rel.split(path.sep);
    const name = parts[parts.length - 1];
    if (!MEMORY_FILES.has(name)) continue;
    const charId = parts[2] ?? "global"; // mem / userId / charId / file.md
    const raw = (await readWhole(parts)) ?? "";
    out.push({ charId, relParts: parts, raw, lines: raw.split("\n") });
  }
  return out;
}

function parseFile(file: MemoryFile): ParsedLine[] {
  const out: ParsedLine[] = [];
  for (let i = 0; i < file.lines.length; i++) {
    const parsed = parseLine(file.charId, file.lines[i], i);
    if (parsed) out.push(parsed);
  }
  return out;
}

const COMMENT_RE = /<!--([\s\S]*?)-->/;

/** Parse one markdown bullet into a memory item, or null for non-memory lines. */
export function parseLine(charId: string, raw: string, lineNo: number): ParsedLine | null {
  const line = raw.trim();
  if (!line || line.startsWith("#") || line === "---") return null;
  const bullet = line.replace(/^[-*]\s+/, "");
  if (bullet === line) return null; // not a bullet line

  const comment = bullet.match(COMMENT_RE);
  const head = (comment ? bullet.slice(0, comment.index) : bullet).trim();
  const typeMatch = head.match(/^\[([a-z_]+)\]\s*/i);
  const type = typeMatch ? typeMatch[1] : "note";
  const text = (typeMatch ? head.slice(typeMatch[0].length) : head).trim();
  if (!text) return null;

  const tag = comment?.[1] ?? "";
  const src = tag.match(/src:([^\s]+)/)?.[1];
  const sourceMessageIds = src ? src.split(",").filter(Boolean) : [];
  const conf = tag.match(/conf:([0-9.]+)/)?.[1];
  const confidence = conf ? Number.parseFloat(conf) : null;
  const mid = tag.match(/mid:([^\s]+)/)?.[1];

  const characterId = charId === "global" ? null : charId;
  const id = mid ?? hashId(charId, type, text, sourceMessageIds);
  return { id, characterId, type, text, sourceMessageIds, confidence, lineNo };
}

/** Stable id for legacy lines without an explicit mid (survives re-reads). */
function hashId(charId: string, type: string, text: string, src: string[]): string {
  const h = createHash("sha1")
    .update(`${charId}|${type}|${text}|${src.join(",")}`)
    .digest("hex")
    .slice(0, 16);
  return `mem_${h}`;
}

/** Render a memory item back to its canonical bullet line (carries a stable mid). */
export function renderLine(item: MemoryItem): string {
  const parts = [`src:${item.sourceMessageIds.join(",")}`, `mid:${item.id}`];
  if (item.confidence != null) parts.push(`conf:${item.confidence}`);
  return `- [${item.type}] ${item.text} <!-- ${parts.join(" ")} -->`;
}

function joinLines(lines: string[]): string {
  // Drop a trailing empty element so we don't accumulate blank lines on rewrite,
  // then re-add the single terminating newline the append path expects.
  const trimmed = [...lines];
  while (trimmed.length && trimmed[trimmed.length - 1].trim() === "") trimmed.pop();
  return trimmed.length ? `${trimmed.join("\n")}\n` : "";
}

// Re-export for callers that build paths relative to the FS root in tests.
export const memoriesRoot = (): string => env.CHAT_FS_ROOT;
