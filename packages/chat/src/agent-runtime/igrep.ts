import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, copyFile, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Context } from "@deepseek-ai/cordis";
import {
  companionWorkspaceRebuildSessionIngestTimeoutMs,
  companionWorkspaceRebuildSchema,
} from "@idream/shared/chat/companion-runtime";
import {
  rebuildSourceMetrics,
  rebuildSpoolSessions,
  type CompanionWorkspaceRebuildSource,
} from "./rebuild-source";
import {
  invalidBoundedCommandOutput,
  runBoundedTextCommand,
} from "./bounded-command";
import type {
  MemoryProbe,
  MemoryStatus,
} from "./workspace";
import { logger } from "../logger";

// SPEC: the normal profile exposes exactly one model-visible igrep surface:
// memory (wake profile + memory_search). `igrep_search` is off.
// INTENT: the working-tree search tool only ever saw `knowledge/canon.md`,
// whose bytes are already inside the compiled Soul, while its coding-agent
// guidance ("grep, glob, bash, repository facts") landed verbatim in every
// companion prompt. Removing the capability removes the tool, the guidance,
// the routing skill and the failure-moment reminder in one place.
// INTENT: memorySearchMode "fast": the plugin default "ultra" spends 4–40 s
// inside an LLM evidence controller that times out against the local model
// (measured 2026-08-24); "fast" returned the same hits in 0.7 s over a
// relationship-sized corpus. The tool subprocess budget shrinks with it.
export const NORMAL_IGREP_CONFIG = Object.freeze({
  search: false,
  webProvider: false,
  webTool: false,
  memory: true,
  // Main projects only committed Turns into canonical memory. Attempt-local
  // ingest would maintain a disposable copy after commit and then delete it.
  ingest: false,
  wake: true,
  memorySearchMode: "fast",
  timeoutMs: 10_000,
});

export const PRIVATE_IGREP_CONFIG = Object.freeze({
  search: false,
  webProvider: false,
  webTool: false,
  memory: false,
  ingest: false,
  wake: false,
});

export interface IgrepPluginModule {
  readonly name: string;
  readonly inject?: readonly string[];
  apply(ctx: Context, config: Record<string, unknown>): void;
  resolveConfig?(config: Record<string, unknown>): Record<string, unknown>;
}

export interface LoadedIgrepPlugin {
  module: IgrepPluginModule;
  version: string;
  moduleUrl: string;
}

async function moduleFile(specifier: string): Promise<string> {
  if (specifier.startsWith("file:")) return fileURLToPath(specifier);
  if (!isAbsolute(specifier)) {
    throw new Error("DSH_IGREP_PLUGIN_URL must be an absolute path or file: URL");
  }
  const metadata = await stat(specifier);
  return metadata.isDirectory() ? join(specifier, "index.mjs") : specifier;
}

export async function loadIgrepPlugin(specifier: string): Promise<LoadedIgrepPlugin> {
  const file = await moduleFile(specifier);
  const moduleUrl = pathToFileURL(resolve(file)).href;
  const namespace = await import(moduleUrl) as Partial<IgrepPluginModule>;
  if (namespace.name !== "igrep" || typeof namespace.apply !== "function") {
    throw new Error("DSH_IGREP_PLUGIN_URL is not the official igrep DSH module namespace");
  }
  const packageJson = JSON.parse(
    await readFile(join(dirname(file), "package.json"), "utf8"),
  ) as { name?: string; version?: string };
  if (packageJson.name !== "@igrep/dsh-plugin" || packageJson.version !== "0.1.0") {
    throw new Error("igrep plugin package identity must be @igrep/dsh-plugin@0.1.0");
  }
  return { module: namespace as IgrepPluginModule, version: packageJson.version, moduleUrl };
}

export interface JsonCommandOptions {
  command: string;
  args: string[];
  stdin?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export type RunJsonCommand = (options: JsonCommandOptions) => Promise<unknown>;

async function sameRealPath(left: string, right: string): Promise<boolean> {
  try {
    return await realpath(left) === await realpath(right);
  } catch {
    return false;
  }
}

export async function runJsonCommand(options: JsonCommandOptions): Promise<unknown> {
  const stdout = await runBoundedTextCommand({
    command: options.command,
    args: options.args,
    stdin: options.stdin,
    timeoutMs: options.timeoutMs ?? 10_000,
    signal: options.signal,
  });
  try {
    return JSON.parse(stdout);
  } catch {
    throw invalidBoundedCommandOutput(stdout);
  }
}

export interface IgrepWake {
  outcome: "hit" | "empty";
  resultCount: 0 | 1;
  /** Resident profile markdown for this turn's prompt; never placed on the wire. */
  profile: string;
}

/**
 * Gate E observes the actual official wake command instead of inferring it
 * from prompt assembly. The profile bytes stay in this process: the engine
 * injects them through the plugin's own prompt variable so the prompt cannot
 * race the plugin's asynchronous wake cache, and the wire event carries counts.
 */
export async function observeIgrepWake(
  command: string,
  workspace: string,
  signal?: AbortSignal,
  run: RunJsonCommand = runJsonCommand,
): Promise<IgrepWake> {
  const payload = objectRecord(await run({
    command,
    args: [
      "mem", "wake",
      "--workspace", workspace,
      "--max-context-chars", "12000",
      "--format", "provider-json",
    ],
    timeoutMs: 10_000,
    signal,
  }));
  if (!payload || typeof payload.markdownContext !== "string") {
    throw new Error("igrep wake returned unverifiable evidence");
  }
  const profile = payload.markdownContext.trim();
  return profile
    ? { outcome: "hit", resultCount: 1, profile }
    : { outcome: "empty", resultCount: 0, profile: "" };
}

export interface IgrepRecallHit {
  citation: string;
  snippet: string;
  sourceClass: string;
}

export interface IgrepRecall {
  outcome: "hit" | "empty";
  resultCount: number;
  /** Projected hits, kept for content-free evidence accounting. */
  results: IgrepRecallHit[];
  /** Prompt-ready dialogue notes; profile hits are excluded because wake already carries the profile. */
  notes: string[];
}

const RECALL_MAX_RESULTS = 6;
// A hit includes neighboring dialogue. A 320-character preview can consume
// the entire budget on an assistant paragraph and remove the user's fact.
// Keep complete ordinary passages while bounding six notes to 12k characters.
const RECALL_NOTE_MAX_CHARS = 2_000;
// INTENT: fast recall is normally sub-second, but the local maintenance model
// can cold-load past 10s after a runtime restart. The Turn deadline still owns
// the outer bound; this prevents a healthy cold start from failing the reply.
const RECALL_TIMEOUT_MS = 30_000;

/**
 * SPEC: recall is pushed, not pulled. Before the model speaks, the current
 * user message is searched against the relationship memory with the same
 * public `memory-search` seam the plugin tool uses, so a companion remembers
 * without spending a tool round-trip (one extra model step) on every turn.
 * INTENT: "fast" mode is the only mode whose latency fits in front of first
 * token (0.7 s measured); the model-invoked memory_search remains for explicit
 * lookups the message itself does not surface.
 */
export async function recallIgrepMemory(
  command: string,
  workspace: string,
  query: string,
  options: { referenceAt?: string; signal?: AbortSignal } = {},
  run: RunJsonCommand = runJsonCommand,
): Promise<IgrepRecall> {
  const payload = objectRecord(await run({
    command,
    args: ["mem-api", "memory-search", "--payload", "-"],
    stdin: `${JSON.stringify({
      workspace,
      query,
      max_results: RECALL_MAX_RESULTS,
      search_mode: "fast",
      reference_at: options.referenceAt ?? new Date().toISOString(),
    })}\n`,
    timeoutMs: RECALL_TIMEOUT_MS,
    signal: options.signal,
  }));
  if (!payload || payload.failed === true || payload.error || !Array.isArray(payload.results)) {
    throw new Error("igrep memory-search returned unverifiable evidence");
  }
  const results = payload.results.map((hit): IgrepRecallHit => {
    const record = objectRecord(hit) ?? {};
    return {
      citation: typeof record.citation === "string" ? record.citation : "",
      snippet: typeof record.snippet === "string" ? record.snippet : "",
      sourceClass: typeof record.sourceClass === "string" ? record.sourceClass : "",
    };
  });
  const notes = results
    .filter((hit) => hit.sourceClass !== "profile")
    .map((hit) => recallNote(hit.snippet))
    .filter((note) => note.length > 0);
  return {
    outcome: results.length > 0 ? "hit" : "empty",
    resultCount: results.length,
    results,
    notes,
  };
}

/** `L12: [user @ 2026-08-24] text` lines become `[user @ 2026-08-24] text`. */
function recallNote(snippet: string): string {
  const text = snippet
    .split("\n")
    .map((line) => line.replace(/^L\d+:\s*/u, "").trim())
    .filter(Boolean)
    .join(" ");
  if (text.length <= RECALL_NOTE_MAX_CHARS) return text;
  const notice = " [Excerpt incomplete; use memory_search for the complete original fact.]";
  const prefix = text.slice(0, RECALL_NOTE_MAX_CHARS - notice.length);
  // Never turn half of an identifier into an apparently remembered fact.
  const completeWords = prefix.replace(/\s*\S*$/u, "");
  return `${completeWords}${notice}`;
}

export class IgrepMemoryProbe implements MemoryProbe {
  constructor(private readonly command: string) {}

  async status(workspace: string): Promise<MemoryStatus> {
    const payload = await runJsonCommand({
      command: this.command,
      args: ["mem-api", "memory-status", "--payload", "-"],
      stdin: `${JSON.stringify({ workspace })}\n`,
    }) as {
      error?: unknown;
      memory?: {
        dialogueFiles?: unknown;
        pendingProfileRows?: unknown;
        processedProfileRows?: unknown;
        lastMaintain?: { at?: unknown } | null;
      };
    };
    if (payload.error) {
      throw invalidBoundedCommandOutput(JSON.stringify(payload.error));
    }
    const dialogueFiles = payload.memory?.dialogueFiles;
    if (!Number.isSafeInteger(dialogueFiles) || Number(dialogueFiles) < 0) {
      throw new Error("igrep memory-status omitted a valid memory.dialogueFiles count");
    }
    const pendingProfileRows = payload.memory?.pendingProfileRows;
    const processedProfileRows = payload.memory?.processedProfileRows;
    if (!Number.isSafeInteger(pendingProfileRows) || Number(pendingProfileRows) < 0
      || !Number.isSafeInteger(processedProfileRows) || Number(processedProfileRows) < 0) {
      throw new Error("igrep memory-status omitted valid profile row counts");
    }
    const lastMaintainAt = payload.memory?.lastMaintain?.at;
    if (lastMaintainAt !== undefined && typeof lastMaintainAt !== "string") {
      throw new Error("igrep memory-status returned an invalid lastMaintain.at");
    }
    return {
      dialogueFiles: Number(dialogueFiles),
      pendingProfileRows: Number(pendingProfileRows),
      processedProfileRows: Number(processedProfileRows),
      lastMaintainAt: lastMaintainAt ?? null,
    };
  }
}

export class IgrepMemoryBuilder {
  constructor(
    private readonly command: string,
    private readonly probe: MemoryProbe = new IgrepMemoryProbe(command),
    private readonly run: RunJsonCommand = runJsonCommand,
  ) {}

  async build(
    workspace: string,
    input: CompanionWorkspaceRebuildSource,
    signal?: AbortSignal,
  ): Promise<{
    sessions: number;
    messages: number;
    sourceReady: true;
    derivation: "accepted" | "rejected";
    rejectionReason?: MemorySourceIntegrityReason;
  }> {
    const source = "kind" in input ? input : companionWorkspaceRebuildSchema.parse(input);
    const metrics = rebuildSourceMetrics(source);
    await memorySourceRoot(workspace);
    // The transcript is transport input, not canonical memory. Keep it beside
    // the candidate .igrep so atomic promotion cannot retain a second copy.
    const transcriptsRoot = join(workspace, ".idream-rebuild-transcripts");
    await mkdir(transcriptsRoot, { recursive: true, mode: 0o700 });
    await chmod(transcriptsRoot, 0o700);
    const sessions: IngestedMemorySource[] = [];
    const ingest = async (session: {
      sessionId: string;
      transcriptPath: string;
      messageCount: number;
      estimatedBytes: number;
    }) => {
      throwIfAborted(signal);
      const result = await this.run({
        command: this.command,
        args: [
          "mem",
          "ingest",
          "--transcript",
          session.transcriptPath,
          "--workspace",
          workspace,
          "--agent",
          "deepseek-harness",
          "--session-id",
          session.sessionId,
        ],
        timeoutMs: companionWorkspaceRebuildSessionIngestTimeoutMs(
          session.estimatedBytes,
        ),
        signal,
      });
      const record = result && typeof result === "object" && !Array.isArray(result)
        ? result as Record<string, unknown>
        : {};
      if (record.events !== session.messageCount || typeof record.dialoguePath !== "string") {
        const actualEvents = Number.isSafeInteger(record.events)
          ? String(record.events)
          : record.events === undefined
            ? "missing"
            : "invalid_type";
        throw new Error(
          `igrep ingest did not verify session ${session.sessionId}: ` +
          `expected ${session.messageCount} events from ${session.estimatedBytes} bytes, ` +
          `got ${actualEvents}`,
        );
      }
      const dialoguePath = resolve(workspace, record.dialoguePath);
      if (dirname(dialoguePath) !== resolve(workspace, ".igrep/mem/memory/dialogues")) {
        throw new Error("igrep ingest returned a dialogue outside its source corpus");
      }
      return dialoguePath;
    };
    const ingestSource = async (session: Parameters<typeof ingest>[0]) => {
      const expected = await memorySourceFingerprint(session.transcriptPath, "transcript", session.sessionId, signal);
      if (expected.rows !== session.messageCount) throw new Error("Main memory transcript row count changed");
      const dialoguePath = await ingest(session);
      sessions.push({ ...session, dialoguePath, expectedDigest: expected.digest });
    };
    if ("kind" in source) {
      for await (const session of rebuildSpoolSessions(source)) {
        const digest = createHash("sha256").update(session.sessionId).digest("hex");
        const transcriptPath = join(transcriptsRoot, `session-${digest}.jsonl`);
        // igrep treats the transcript as workspace input. Keep request spools
        // outside that trust boundary and copy only the validated 0600 bytes
        // into the disposable candidate workspace before invoking the CLI.
        await copyFile(session.transcriptPath, transcriptPath);
        await chmod(transcriptPath, 0o600);
        await ingestSource({ ...session, transcriptPath });
      }
    } else {
      let current: {
        sessionId: string;
        transcriptPath: string;
        messageCount: number;
        estimatedBytes: number;
        handle: Awaited<ReturnType<typeof open>>;
      } | undefined;
      const finish = async () => {
        if (!current) return;
        await current.handle.sync();
        await current.handle.close();
        await ingestSource(current);
        current = undefined;
      };
      try {
        for (const message of source.messages) {
          if (current?.sessionId !== message.sessionId) {
            await finish();
            const digest = createHash("sha256").update(message.sessionId).digest("hex");
            const transcriptPath = join(transcriptsRoot, `session-${digest}.jsonl`);
            current = {
              sessionId: message.sessionId,
              transcriptPath,
              messageCount: 0,
              estimatedBytes: 0,
              handle: await open(transcriptPath, "wx", 0o600),
            };
          }
          const row = `${JSON.stringify({
            role: message.role,
            content: message.content,
            source_at: message.createdAt,
            source_timezone: "UTC",
          })}\n`;
          await current.handle.write(row);
          current.messageCount += 1;
          current.estimatedBytes += Buffer.byteLength(row);
        }
        await finish();
      } finally {
        await current?.handle.close().catch(() => undefined);
      }
    }
    let rejectionReason: MemorySourceIntegrityReason | undefined;
    try {
      const before = await verifyMemorySourceCorpus(workspace, sessions, signal);
      await this.run({
        command: this.command,
        args: ["mem", "maintain", "--workspace", workspace, ...(source.mode === "rebuild" ? ["--rebuild"] : [])],
        timeoutMs: 300_000,
        signal,
      });
      const after = await verifyMemorySourceCorpus(workspace, sessions, signal);
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        throw new MemorySourceIntegrityError("dialogue_changed_during_maintenance");
      }
    } catch (error) {
      if (!(error instanceof MemorySourceIntegrityError)) throw error;
      rejectionReason = error.reason;
      throwIfAborted(signal);
      // The surrounding workspace is an unpublished candidate. Discard the
      // whole derived store, never patch annotations or retain a deleted Main
      // source from its old canonical seed. Retry ingestion only, exactly once.
      await rm(join(workspace, ".igrep"), { recursive: true, force: true });
      await mkdir(join(workspace, ".igrep"), { recursive: true, mode: 0o700 });
      for (const session of sessions) {
        const current = await memorySourceFingerprint(session.transcriptPath, "transcript", session.sessionId, signal);
        if (current.digest !== session.expectedDigest || current.rows !== session.messageCount) {
          throw new Error("Main memory transcript changed before source-only recovery");
        }
        session.dialoguePath = await ingest(session);
      }
      await verifyMemorySourceCorpus(workspace, sessions, signal);
    }
    await this.run({
      command: this.command,
      args: ["mem", "doctor", "--workspace", workspace, "--json", "--strict"],
      timeoutMs: 30_000,
      signal,
    });
    const status = await this.probe.status(workspace);
    const expectedDialogueFiles = metrics.sessionCount;
    if (status.dialogueFiles !== expectedDialogueFiles) {
      throw new Error(
        `igrep memory build dialogue count mismatch: expected ${expectedDialogueFiles}, got ${status.dialogueFiles}`,
      );
    }
    // INTENT: A finished profile pass may leave retryable rows pending when the
    // maintenance model is unavailable or under pressure. The rebuilt
    // workspace already contains only the canonical Chat transcript, so
    // rejecting it here makes privacy deletion depend on optional derivation
    // work and permanently blocks every later mutation for the same user.
    if (!rejectionReason && metrics.messageCount > 0 && !status.lastMaintainAt) {
      throw new Error("igrep memory build did not expose a completed maintain pass");
    }
    if (rejectionReason) {
      logger.warn({
        event: "companion_memory_derivation_rejected",
        mode: source.mode,
        mutationId: source.fence?.mutationId,
        authorityVersion: source.fence?.authorityVersion,
        reason: rejectionReason,
        sourceReady: true,
        sessions: metrics.sessionCount,
        messages: metrics.messageCount,
      }, "rejected memory derivation; rebuilt a source-only candidate");
    }
    return {
      sessions: metrics.sessionCount,
      messages: metrics.messageCount,
      sourceReady: true,
      derivation: rejectionReason ? "rejected" : "accepted",
      ...(rejectionReason ? { rejectionReason } : {}),
    };
  }
}

type MemorySourceIntegrityReason =
  | "dialogue_inventory_mismatch"
  | "dialogue_source_mismatch"
  | "dialogue_format_invalid"
  | "dialogue_changed_during_maintenance"
  | "retractions_present";

class MemorySourceIntegrityError extends Error {
  constructor(readonly reason: MemorySourceIntegrityReason) {
    super(`igrep source integrity rejected: ${reason}`);
  }
}

interface IngestedMemorySource {
  sessionId: string;
  transcriptPath: string;
  messageCount: number;
  estimatedBytes: number;
  dialoguePath: string;
  expectedDigest: string;
}

async function memorySourceFingerprint(path: string, kind: "transcript" | "dialogue", sessionId: string, signal?: AbortSignal) {
  throwIfAborted(signal);
  const digest = createHash("sha256");
  const bytes = createHash("sha256");
  const stream = createReadStream(path, { signal });
  stream.on("data", (chunk) => { bytes.update(chunk); });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let rows = 0;
  try {
    for await (const line of lines) {
      throwIfAborted(signal);
      let row: Record<string, unknown> | null;
      try { row = objectRecord(JSON.parse(line)); } catch { row = null; }
      const sourceAt = kind === "dialogue" ? objectRecord(row?.source_at)?.instant_utc : row?.source_at;
      if (!row || !["user", "assistant"].includes(String(row.role)) || typeof row.content !== "string"
        || typeof sourceAt !== "string" || !Number.isFinite(Date.parse(sourceAt))
        || (kind === "dialogue" && (row.schema !== "igrep.mem.dialogue/1" || row.session_id !== sessionId || row.turn_index !== rows + 1))) {
        throw new MemorySourceIntegrityError("dialogue_format_invalid");
      }
      // Main sends UTC timestamps. Preserve sub-millisecond precision if an
      // already validated source contains it, while normalizing UTC notation.
      const fraction = /\.(\d+)/u.exec(sourceAt)?.[1] ?? "";
      const extraPrecision = fraction.slice(3).replace(/0+$/u, "");
      const instant = new Date(sourceAt).toISOString().replace(/Z$/u, `${extraPrecision}Z`);
      digest.update(JSON.stringify([row.role, row.content, instant])).update("\n");
      rows += 1;
    }
  } finally {
    lines.close();
    stream.destroy();
  }
  return { rows, digest: digest.digest("hex"), bytes: bytes.digest("hex") };
}

/**
 * Versioned private-file admission check for the installed igrep dialogue/1
 * format. It verifies Main's source and rejects derived retractions; it does
 * not validate Dream's profile semantics or grant natural-language deletion.
 */
async function verifyMemorySourceCorpus(workspace: string, sessions: readonly IngestedMemorySource[], signal?: AbortSignal) {
  throwIfAborted(signal);
  const memoryRoot = await memorySourceRoot(workspace);
  const directory = join(workspace, ".igrep/mem/memory/dialogues");
  const regularFile = async (path: string) => {
    const metadata = await lstat(path);
    const within = relative(memoryRoot, await realpath(path));
    if (!metadata.isFile() || metadata.isSymbolicLink() || within === ".." || within.startsWith(`..${sep}`) || isAbsolute(within)) {
      throw new MemorySourceIntegrityError("dialogue_format_invalid");
    }
  };
  let entries: string[];
  try {
    const metadata = await lstat(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()
      || await realpath(directory) !== join(memoryRoot, "mem/memory/dialogues")) {
      throw new MemorySourceIntegrityError("dialogue_format_invalid");
    }
    entries = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    entries = [];
  }
  const expected = sessions.map((session) => relative(directory, session.dialoguePath)).sort();
  if (JSON.stringify([...entries].sort()) !== JSON.stringify(expected)) {
    throw new MemorySourceIntegrityError("dialogue_inventory_mismatch");
  }
  const fingerprints: string[] = [];
  for (const session of sessions) {
    throwIfAborted(signal);
    await regularFile(session.dialoguePath);
    const actual = await memorySourceFingerprint(session.dialoguePath, "dialogue", session.sessionId, signal);
    if (actual.rows !== session.messageCount || actual.digest !== session.expectedDigest) {
      throw new MemorySourceIntegrityError("dialogue_source_mismatch");
    }
    fingerprints.push(actual.bytes);
  }
  const retractions = join(workspace, ".igrep/mem/.state/retractions.jsonl");
  try {
    await regularFile(retractions);
    if ((await readFile(retractions, { encoding: "utf8", signal })).trim()) {
      throw new MemorySourceIntegrityError("retractions_present");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return fingerprints;
}

async function memorySourceRoot(workspace: string): Promise<string> {
  const path = join(workspace, ".igrep");
  const metadata = await lstat(path);
  const root = await realpath(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()
    || root !== join(await realpath(workspace), ".igrep")) {
    throw new MemorySourceIntegrityError("dialogue_format_invalid");
  }
  // Check the known source/annotation paths before the CLI can write through
  // a copied seed. Missing directories are created by official ingest.
  for (const directory of ["mem", "mem/memory", "mem/memory/dialogues", "mem/.state"]) {
    const expected = join(root, directory);
    try {
      const child = await lstat(expected);
      if (!child.isDirectory() || child.isSymbolicLink() || await realpath(expected) !== expected) {
        throw new MemorySourceIntegrityError("dialogue_format_invalid");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return root;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new Error("igrep command aborted");
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export async function igrepVersion(
  command: string,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<string> {
  const stdout = await runBoundedTextCommand({
    command,
    args: ["--version"],
    timeoutMs: options.timeoutMs ?? 10_000,
    signal: options.signal,
  });
  const match = /(?:^|\s)(\d+\.\d+\.\d+)(?:\s|$)/.exec(stdout.trim());
  if (!match?.[1]) throw invalidBoundedCommandOutput(stdout);
  return match[1];
}

/**
 * A disposable write/maintain/status cycle proves the executable can finish
 * the exact lifecycle required before a canonical relationship promotion.
 */
export interface IgrepLifecycleProbeEvidence {
  duplicateIngest: {
    replayedSessions: number;
    duplicateDialogueFiles: 0;
  };
  crossScope: {
    probes: number;
    leakedResults: 0;
  };
}

export async function probeIgrepLifecycle(
  command: string,
  dependencies: {
    run?: RunJsonCommand;
    status?(workspace: string): Promise<MemoryStatus>;
    nonce?(): string;
  } = {},
): Promise<IgrepLifecycleProbeEvidence> {
  const root = await mkdtemp(join(tmpdir(), "idream-igrep-ready-"));
  const workspaces = [join(root, "scope-a"), join(root, "scope-b")] as const;
  const nonce = dependencies.nonce?.() ?? `${process.pid}-${Date.now()}`;
  const sentinels = [`scope-a-${nonce}`, `scope-b-${nonce}`] as const;
  const run = dependencies.run ?? runJsonCommand;
  const status = dependencies.status ?? ((workspace: string) =>
    new IgrepMemoryProbe(command).status(workspace));
  const ingest = async (workspace: string, sentinel: string, sessionId: string) => {
    const transcript = join(workspace, "readiness.jsonl");
    await writeFile(transcript, [
      JSON.stringify({ role: "user", content: `readiness ${sentinel}` }),
      JSON.stringify({ role: "assistant", content: `acknowledged ${sentinel}` }),
      "",
    ].join("\n"), { mode: 0o600 });
    await run({
      command,
      args: [
        "mem", "ingest",
        "--workspace", workspace,
        "--transcript", transcript,
        "--agent", "idream-readiness",
        "--session-id", sessionId,
        "--format", "json",
      ],
      timeoutMs: 30_000,
    });
  };
  try {
    await Promise.all(workspaces.map((workspace) => mkdir(workspace, { recursive: true })));
    const sessionId = `readiness-${nonce}`;
    await ingest(workspaces[0], sentinels[0], sessionId);
    const beforeReplay = await status(workspaces[0]);
    await ingest(workspaces[0], sentinels[0], sessionId);
    const afterReplay = await status(workspaces[0]);
    const duplicateDialogueFiles = afterReplay.dialogueFiles - beforeReplay.dialogueFiles;
    if (beforeReplay.dialogueFiles < 1 || duplicateDialogueFiles !== 0) {
      throw new Error(`igrep replay created ${duplicateDialogueFiles} duplicate dialogue files`);
    }
    await ingest(workspaces[1], sentinels[1], `${sessionId}-scope-b`);

    for (const workspace of workspaces) {
      await run({
        command,
        args: ["mem", "maintain", "--workspace", workspace],
        timeoutMs: 120_000,
      });
      const observed = await status(workspace);
      if (observed.dialogueFiles < 1) {
        throw new Error("igrep readiness lifecycle did not persist dialogue evidence");
      }
      if ((observed.pendingProfileRows ?? 0) !== 0 || !observed.lastMaintainAt) {
        throw new Error(
          `igrep readiness lifecycle did not settle: pending=${observed.pendingProfileRows ?? "missing"}`,
        );
      }
    }

    let leakedResults = 0;
    for (const [workspace, foreignSentinel] of [
      [workspaces[0], sentinels[1]],
      [workspaces[1], sentinels[0]],
    ] as const) {
      const recalled = objectRecord(await run({
        command,
        args: ["mem-api", "memory-search", "--payload", "-"],
        stdin: `${JSON.stringify({ workspace, query: foreignSentinel })}\n`,
        timeoutMs: 30_000,
      }));
      const workspaceMatches = typeof recalled?.workspaceRoot === "string"
        && await sameRealPath(recalled.workspaceRoot, workspace);
      if (
        recalled?.provider !== "igrep"
        || recalled.strategy !== "shared-search"
        || !workspaceMatches
        || !Array.isArray(recalled.results)
        || !Array.isArray(recalled.warnings)
        || recalled.warnings.length !== 0
        || typeof recalled.markdownContext !== "string"
      ) {
        throw new Error("igrep cross-scope readiness probe returned unverifiable evidence");
      }
      if (`${recalled.markdownContext}\n${JSON.stringify(recalled.results)}`.includes(foreignSentinel)) {
        leakedResults += 1;
      }
    }
    if (leakedResults !== 0) {
      throw new Error(`igrep cross-scope readiness probe leaked ${leakedResults} results`);
    }
    return {
      duplicateIngest: { replayedSessions: 1, duplicateDialogueFiles: 0 },
      crossScope: { probes: 2, leakedResults: 0 },
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
