// SPEC: Long-term memory candidate extraction (P1-C). Two extractors behind ONE
// stable entry (extractCandidates), mirroring retrieval.ts's igrep+degrade shape:
//   - heuristic (default): deterministic EN/ZH regex — fast, testable, no deps.
//   - igrep (CHAT_MEMORY_EXTRACT=igrep): `igrep mem derive --llm` semantically
//     extracts structured observations off the turn, with a STRICT timeout that
//     DEGRADES to the full regex on timeout/error/empty (P0: never block memory
//     writing on a flaky LLM — and this already runs OFF the hot path, in the
//     chat.memory.extract worker, so the reply is never affected either way).
// INVARIANTS:
//   - BOUNDARIES are ALWAYS taken from the regex floor, never from igrep: igrep
//     has no "boundary" observation kind and boundaries are a hard safety
//     invariant (PRD §16.2) — we must not depend on an LLM to catch "don't bring
//     up X". igrep contributes user_fact/preference; the regex guarantees the
//     boundary regardless.
//   - The deterministic (no-LLM) igrep fallback echoes the whole turn as one
//     observation; we drop that echo and prefer the regex, so memory never fills
//     with raw verbatim turns.
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { env } from "./env.js";

export interface MemoryCandidate {
  scope: "global" | "character" | "session";
  type: "user_fact" | "preference" | "boundary" | "shared_event";
  text: string;
  confidence: number;
  sourceMessageIds: string[];
}

export interface ExtractInput {
  userText: string;
  sourceMessageId: string;
  userId: string;
  characterId: string;
}

/**
 * Extract long-term memory candidates from one user turn. igrep mem derive when
 * enabled (semantic), else the regex floor; the regex boundary is always kept.
 */
export async function extractCandidates(input: ExtractInput): Promise<MemoryCandidate[]> {
  const regex = deriveCandidates(input.userText, input.sourceMessageId);
  if (env.MEMORY_EXTRACT !== "igrep") return regex;

  const igrep = await igrepDerive(input).catch(() => null);
  if (!igrep || igrep.length === 0) return regex; // timeout/error/echo-only → regex floor

  // Semantic candidates from igrep + the GUARANTEED regex boundaries. Dedup of
  // overlap with stored memory is handled downstream by consolidateMemories.
  const boundaries = regex.filter((c) => c.type === "boundary");
  return [...igrep, ...boundaries];
}

// ---- igrep mem derive -------------------------------------------------------

interface DeriveObservation {
  kind?: string;
  content?: string;
  confidence?: number;
}

/**
 * Run `igrep mem derive --llm --dry-run` over the user turn and map the LLM
 * observations to candidates. Returns [] when igrep produced nothing granular
 * (deterministic whole-turn echo is dropped). Rejects on spawn/timeout/parse
 * error so the caller degrades to the regex floor.
 */
async function igrepDerive(input: ExtractInput): Promise<MemoryCandidate[]> {
  const ws = await mkdtemp(path.join(tmpdir(), "chat-derive-"));
  try {
    // Session must live inside an igrep memory root (.igrep/mem/...).
    const sessionRel = path.join("memory", "turn.jsonl");
    const sessionAbs = path.join(ws, ".igrep", "mem", sessionRel);
    await mkdir(path.dirname(sessionAbs), { recursive: true });
    await writeFile(sessionAbs, `${JSON.stringify({ role: "user", content: input.userText })}\n`, "utf8");

    const args = [
      "--json",
      "mem",
      "derive",
      "--workspace",
      ws,
      "--session",
      sessionRel,
      "--observer",
      "agent:companion",
      "--observed",
      `user:${input.userId}`,
      "--dry-run",
    ];
    if (env.MEMORY_EXTRACT_LLM) {
      args.push("--llm", "--llm-timeout-s", String(Math.max(1, Math.floor(env.MEMORY_EXTRACT_TIMEOUT_MS / 1000))));
      if (env.MEMORY_EXTRACT_MODEL) args.push("--llm-model", env.MEMORY_EXTRACT_MODEL);
    }

    // Point igrep's LLM at our OpenAI-compatible endpoint (omlx by default) and
    // disable the model's "thinking" mode — Qwen reasoning models otherwise emit
    // <think> prose that breaks igrep's observations[] JSON parse. Extra body is
    // tunable per deployment (CHAT_MEMORY_EXTRACT_EXTRA_BODY).
    const spawnEnv: NodeJS.ProcessEnv = {
      ...process.env,
      IGREP_LLM_URL: env.MEMORY_EXTRACT_LLM_URL,
      IGREP_API_KEY: env.MEMORY_EXTRACT_LLM_KEY,
      ...(env.MEMORY_EXTRACT_MODEL ? { IGREP_LLM_MODEL: env.MEMORY_EXTRACT_MODEL } : {}),
      ...(env.MEMORY_EXTRACT_EXTRA_BODY ? { IGREP_LLM_EXTRA_BODY: env.MEMORY_EXTRACT_EXTRA_BODY } : {}),
    };

    const raw = await runWithTimeout(env.IGREP_BIN, args, env.MEMORY_EXTRACT_TIMEOUT_MS, spawnEnv);
    const observations = (JSON.parse(raw) as { observations?: DeriveObservation[] }).observations ?? [];

    const turn = normalize(input.userText);
    const out: MemoryCandidate[] = [];
    for (const obs of observations) {
      const text = clamp((obs.content ?? "").trim());
      if (!isMeaningful(text)) continue; // drop empty / degenerate ("...") junk
      if (normalize(text) === turn) continue; // drop the deterministic whole-turn echo
      out.push({
        scope: "character",
        type: mapKind(obs.kind),
        text,
        confidence: clampConfidence(obs.confidence),
        sourceMessageIds: [input.sourceMessageId],
      });
    }
    return out;
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
}

/** igrep observation kind → our memory type. Boundaries never come from igrep. */
function mapKind(kind: string | undefined): "user_fact" | "preference" {
  return kind === "preference" ? "preference" : "user_fact";
}

function clampConfidence(c: number | undefined): number {
  if (typeof c !== "number" || !Number.isFinite(c)) return 0.7;
  return Math.min(1, Math.max(0, c));
}

function clamp(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length <= 200 ? t : `${t.slice(0, 199)}…`;
}

/** A candidate must carry real content: >= 3 letter/number/CJK chars. Weak models
 * sometimes emit degenerate observations ("...", "n/a") — those never reach memory. */
function isMeaningful(text: string): boolean {
  return (text.match(/[\p{L}\p{N}]/gu)?.length ?? 0) >= 3;
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").replace(/[.!?。！？]+$/g, "").trim();
}

/** Run a command, resolving stdout; reject on non-zero exit, error, or timeout. */
function runWithTimeout(
  bin: string,
  args: string[],
  timeoutMs: number,
  spawnEnv?: NodeJS.ProcessEnv,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "ignore"], env: spawnEnv });
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
      finish(() => reject(new Error("igrep derive timeout")));
    }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => {
      out += d.toString("utf8");
    });
    child.on("error", (err) => finish(() => reject(err)));
    child.on("close", (code) =>
      finish(() => (code === 0 ? resolve(out) : reject(new Error(`igrep derive exit ${code}`)))),
    );
  });
}

// ---- deterministic regex floor (EN + ZH) ------------------------------------

/** Heuristic extractor — EN + ZH name/preference/boundary. Always available. */
export function deriveCandidates(userText: string, sourceMessageId: string): MemoryCandidate[] {
  const out: MemoryCandidate[] = [];
  const nickname =
    userText.match(/\bcall me ([a-z0-9 _-]{1,40})/i)?.[1]?.trim() ??
    userText.match(/(?:叫我|称呼我为)([\p{Script=Han}a-zA-Z0-9 _-]{1,40})/u)?.[1]?.trim();
  if (nickname) {
    out.push({ scope: "character", type: "preference", text: `User likes being called ${nickname}.`, confidence: 0.84, sourceMessageIds: [sourceMessageId] });
  }
  const liked =
    userText.match(/\bi like ([^.?!]{3,80})/i)?.[1]?.trim() ??
    userText.match(/我喜欢([^。！？\n]{2,80})/u)?.[1]?.trim();
  if (liked) {
    out.push({ scope: "character", type: "preference", text: `User likes ${liked}.`, confidence: 0.78, sourceMessageIds: [sourceMessageId] });
  }
  const boundary =
    userText.match(/\b(?:do not|don't) (?:remember|store|talk about|bring up) ([^.?!]{3,80})/i)?.[1]?.trim() ??
    userText.match(/(?:不要|别)(?:记住|保存|聊|提)([^。！？\n]{2,80})/u)?.[1]?.trim();
  if (boundary) {
    out.push({ scope: "global", type: "boundary", text: `Do not remember, store, or bring up ${boundary}.`, confidence: 0.9, sourceMessageIds: [sourceMessageId] });
  }
  return out;
}
