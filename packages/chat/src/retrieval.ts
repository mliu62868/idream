// SPEC: Long-term memory retrieval (PLAN P1-2). `retrieveMemories` is the stable
// boundary the context builder calls. Default = recency (small per-character
// memory files; fast, deterministic, correct). When CHAT_MEMORY_RETRIEVAL=igrep,
// rank the user's memory lines by semantic relevance to the current turn using
// the igrep CLI, with a STRICT timeout that DEGRADES back to recency on
// timeout/error/empty — so the hot path never depends on igrep (PLAN: "P0 热路径
// 不依赖 igrep；P1 接入带超时 + 退化"). Boundaries are ALWAYS returned in full
// (they are high-priority constraints, never subject to relevance pruning).
// INTENT: caller interface unchanged — context.ts swaps its file read for this.
import { spawn } from "node:child_process";
import path from "node:path";
import { env } from "./env.js";
import { chatFsPaths, readWhole } from "./chat-fs.js";
import { parseLine } from "./memories.js";

export interface RetrieveInput {
  userId: string;
  characterId: string;
  /** the current user turn — used as the semantic query when igrep is enabled. */
  query: string;
  max: number;
}

export interface MemoryRetrieval {
  boundaries: string[];
  memories: string[];
}

/** Retrieve boundaries (all) + the most relevant long-term memories (<= max). */
export async function retrieveMemories(input: RetrieveInput): Promise<MemoryRetrieval> {
  const [boundariesRaw, memoryRaw] = await Promise.all([
    readWhole(chatFsPaths.boundaries(input.userId)),
    readWhole(chatFsPaths.memory(input.userId, input.characterId)),
  ]);

  const boundaries = parseTexts(boundariesRaw, "global");
  const all = parseTexts(memoryRaw, input.characterId);
  if (all.length === 0) return { boundaries, memories: [] };

  if (env.MEMORY_RETRIEVAL === "igrep" && input.query.trim()) {
    const ranked = await igrepRank(input, all).catch(() => null);
    if (ranked && ranked.length) return { boundaries, memories: ranked.slice(0, input.max) };
  }

  // recency baseline: newest entries are appended last.
  return { boundaries, memories: all.slice(-input.max) };
}

/** Parse a memory file into clean text lines (drops the inline src/mid tags). */
function parseTexts(raw: string | null, charId: string): string[] {
  if (!raw) return [];
  const out: string[] = [];
  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const parsed = parseLine(charId, lines[i], i);
    if (parsed) out.push(parsed.text);
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
