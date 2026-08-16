// SPEC: Long-term memory retrieval (PLAN P1-2). `retrieveMemories` is the stable
// boundary the context builder calls. Default = PRIORITY + a recency reserve
// (small per-character memory files; fast, deterministic, no deps). When
// CHAT_MEMORY_RETRIEVAL=igrep, rank the user's memory lines by semantic
// relevance to the current turn using the igrep CLI, with a STRICT timeout that
// DEGRADES back to the default on timeout/error/empty — so the hot path never
// depends on igrep (PLAN: "P0 热路径不依赖 igrep；P1 接入带超时 + 退化").
// Boundaries are ALWAYS returned in full (they are high-priority constraints,
// never subject to relevance pruning).
// INTENT: caller interface unchanged — context.ts swaps its file read for this.
import { spawn } from "node:child_process";
import path from "node:path";
import { env } from "./env.js";
import { chatFsPaths, readWhole } from "./chat-fs.js";
import { memoryPriority, parseLine, type MemoryItem } from "./memories.js";

export interface RetrieveInput {
  userId: string;
  characterId: string;
  /** the current user turn — used as the semantic query when igrep is enabled. */
  query: string;
  max: number;
}

/**
 * Read the user's global boundaries IN FULL, every turn (design P0-G). Boundaries
 * are safety constraints — they are NEVER ranked, capped, or degraded on timeout.
 * Returns [] when the file is absent (ENOENT). A genuine read error (EISDIR,
 * EACCES, …) PROPAGATES so the caller can fail closed rather than silently drop a
 * user's boundaries and risk an out-of-bounds reply.
 */
export async function readBoundaries(userId: string): Promise<string[]> {
  const raw = await readWhole(chatFsPaths.boundaries(userId));
  return parseItems(raw, "global").map((item) => item.text);
}

/** Retrieve the most relevant long-term memories (<= max). Degradable on the hot path. */
export async function retrieveMemories(input: RetrieveInput): Promise<string[]> {
  const memoryRaw = await readWhole(chatFsPaths.memory(input.userId, input.characterId));
  const all = parseItems(memoryRaw, input.characterId);
  if (all.length === 0) return [];

  let ranked: string[] = [];
  if (env.MEMORY_RETRIEVAL === "igrep" && input.query.trim()) {
    ranked = (await igrepRank(input, all.map((item) => item.text)).catch(() => null)) ?? [];
  }
  return selectMemories(all, ranked, input.max);
}

/**
 * Fill the turn's memory quota from three sources, in order:
 *   1. igrep relevance hits (igrep mode only) — they own the top slots, and the
 *      timeout/error/empty degrade path simply arrives here with none.
 *   2. PRIORITY — highest memoryPriority() first. This is the SAME ranking the
 *      storage cap evicts by (memories.ts capItems), so what survives on disk is
 *      exactly what can reach a prompt: the birthday learned on turn 3 is still
 *      retrievable on turn 500 instead of being buried by small talk.
 *   3. RECENCY — the newest lines fill a reserved ~1/3 of the quota, so "what
 *      just happened" always has a seat and priority can't freeze the block.
 * Output = igrep hits in relevance order, then the rest in file (chronological)
 * order, so the injected block still reads as a timeline.
 */
function selectMemories(all: MemoryItem[], ranked: string[], max: number): string[] {
  if (max <= 0) return [];
  const picked = new Set(ranked.slice(0, max));
  // With a single slot, priority takes it: forgetting the user's name is worse
  // than forgetting this afternoon.
  const recencyReserve = max > 1 ? Math.max(1, Math.floor(max / 3)) : 0;

  // newest-first before a stable sort → equal-priority ties break toward newer.
  const byPriority = [...all].reverse().sort((a, b) => memoryPriority(b) - memoryPriority(a));
  for (const item of byPriority) {
    if (picked.size >= max - recencyReserve) break;
    picked.add(item.text);
  }
  for (let i = all.length - 1; i >= 0 && picked.size < max; i--) picked.add(all[i].text);

  const out = ranked.filter((text) => picked.has(text));
  for (const item of all) {
    if (picked.has(item.text) && !out.includes(item.text)) out.push(item.text);
  }
  return out.slice(0, max);
}

/** Parse a memory file into items, oldest first (drops the inline src/mid tags). */
function parseItems(raw: string | null, charId: string): MemoryItem[] {
  if (!raw) return [];
  const out: MemoryItem[] = [];
  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const parsed = parseLine(charId, lines[i], i);
    if (parsed) out.push(parsed);
  }
  return out;
}

/**
 * Rank `candidates` by igrep semantic relevance to the query. Returns texts in
 * relevance order (intersected with our parsed candidates so we never inject a
 * line that isn't an authoritative memory). Rejects on timeout/spawn error.
 */
async function igrepRank(input: RetrieveInput, candidates: string[]): Promise<string[]> {
  const memDir = path.resolve(env.CHAT_FS_ROOT, "mem", input.userId, input.characterId);
  const args = ["search", input.query, memDir, "--json", "--mode", "fast", "--no-color", "-m", String(Math.max(input.max, 10))];
  const raw = await runWithTimeout(env.IGREP_BIN, args, env.MEMORY_RETRIEVAL_TIMEOUT_MS);

  // igrep emits JSONL; each result has a `content` blob with "Ln: <line>" rows.
  // Recover the memory texts in the order igrep surfaced them, keeping only lines
  // that match an authoritative candidate (set membership) and de-duping.
  const known = new Set(candidates);
  const seen = new Set<string>();
  const ranked: string[] = [];
  for (const jsonLine of raw.split("\n")) {
    const trimmed = jsonLine.trim();
    if (!trimmed) continue;
    let content: string;
    try {
      content = String((JSON.parse(trimmed) as { content?: unknown }).content ?? "");
    } catch {
      continue;
    }
    for (const row of content.split("\n")) {
      const parsed = parseLine(input.characterId, row.replace(/^L\d+:\s*/, ""), 0);
      if (!parsed) continue;
      if (known.has(parsed.text) && !seen.has(parsed.text)) {
        seen.add(parsed.text);
        ranked.push(parsed.text);
      }
    }
  }
  return ranked;
}

/** Run a command, resolving its stdout; reject on non-zero exit, error, or timeout. */
function runWithTimeout(bin: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() => reject(new Error("igrep timeout")));
    }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => {
      out += d.toString("utf8");
    });
    child.on("error", (err) => finish(() => reject(err)));
    child.on("close", (code) =>
      finish(() => (code === 0 ? resolve(out) : reject(new Error(`igrep exit ${code}`)))),
    );
  });
}
