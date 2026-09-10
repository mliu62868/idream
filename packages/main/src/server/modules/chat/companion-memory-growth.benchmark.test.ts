import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { createServer } from "node:http";
import { afterAll, describe, expect, it, vi } from "vitest";
import { durableEventEnvelopeSchema } from "@idream/shared/contracts";
import { prisma } from "@/server/lib/db";
import { createCharacter, createUser, purgeTestData } from "@/server/test/helpers";
import { dispatchPendingChatEvents } from "@/processes/chat-outbox";
import { scheduleCompanionMemoryProjection, syncCompanionMemoryFromMain } from "./companion-memory-authority";
import { IgrepMemoryBuilder, IgrepMemoryProbe, observeIgrepWake, recallIgrepMemory, runJsonCommand, type RunJsonCommand } from "../../../../../chat/src/agent-runtime/igrep";
import { AttemptWorkspaceStore, relationshipWorkspacePath } from "../../../../../chat/src/agent-runtime/workspace";
import type { CompanionInvocation } from "../../../../../chat/src/agent-runtime/contracts";
import { rebuildSpoolSessions, type CompanionWorkspaceRebuildPromotion, type CompanionWorkspaceRebuildSpool } from "../../../../../chat/src/agent-runtime/rebuild-source";

// Opt-in only: actual PostgreSQL + installed igrep, not a deterministic CI test.
// Model maintenance is explicitly intercepted unless the bounded live mode is
// requested. The normal test command must never make an ambient model call.
const enabled = process.env.RUN_MEMORY_GROWTH_BENCHMARK === "1";
const live = process.env.MEMORY_GROWTH_LIVE === "1";
const revision = () => execFileSync("node", ["scripts/source-revision.cjs"], { cwd: resolve(import.meta.dirname, "../../../../../.."), encoding: "utf8" }).trim();
const sourceRevision = enabled ? revision() : undefined;
const downstream = vi.hoisted(() => ({ prepare: vi.fn(), promote: vi.fn() }));
vi.mock("../../../../../chat/src/agent-runtime/runtime.js", () => ({
  prepareCompanionWorkspaceRebuild: downstream.prepare,
  promoteCompanionWorkspaceRebuild: downstream.promote,
  purgeCompanionWorkspace: vi.fn(),
}));
const { prepareCompanionMemory, promoteCompanionMemory } = await vi.importActual<{
  prepareCompanionMemory(request: Request): Promise<unknown>;
  promoteCompanionMemory(request: Request): Promise<unknown>;
}>("../../../../../chat/src/companion-memory");

const prefix = `zt-memory-growth-${randomUUID()}-`;
const temporary: string[] = [];
const measurements: Array<Record<string, unknown>> = [];
const providerRequests: Array<Record<string, unknown>> = [];
const cleanup: Array<() => Promise<void>> = [];
const round = (value: number) => Math.round(value * 100) / 100;
async function timed<T>(fn: () => Promise<T>) {
  const started = performance.now();
  const value = await fn();
  return { value, ms: round(performance.now() - started) };
}
async function treeBytes(path: string): Promise<number> {
  let bytes = 0;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    bytes += entry.isDirectory() ? await treeBytes(child) : (await stat(child)).size;
  }
  return bytes;
}

afterAll(async () => {
  vi.restoreAllMocks();
  if (!enabled) return;
  await prisma.mainOutboxEvent.deleteMany({ where: { aggregateId: { startsWith: prefix } } });
  await prisma.companionMemoryAuthority.deleteMany({ where: { aggregateId: { startsWith: prefix } } });
  await purgeTestData(prefix);
  await Promise.all(temporary.map(path => rm(path, { recursive: true, force: true })));
  await Promise.all(cleanup.map(close => close()));
  const path = process.env.MEMORY_GROWTH_REPORT;
  if (path) await writeFile(path, `${JSON.stringify({
    sourceRevision,
    sourceRevisionAtCompletion: revision(),
    completedAt: new Date().toISOString(),
    method: "Real isolated Main PostgreSQL, actual dispatch leases and coalescing, Main NDJSON stream, Chat decoder, workspace promotion, installed igrep ingest/doctor/status/wake. In-process HTTP Request transport excludes network latency. Synthetic 1000-character content across interleaved sessions. One sample per phase; not a throughput SLA.",
    limitations: live
      ? "Only the 100-message bootstrap performs real maintenance (one CLI pass, short repeated facts). Other maintenance calls and their completion timestamp are intercepted; at most 3 real fast recalls. All model/embedding/rerank HTTP is routed through a task-local forwarding counter with a combined 4-request ceiling; failures stop the run. No conversational model or user-visible first-token measurement."
      : "All maintenance commands and their completion timestamp are intercepted. No recall, embedding or model request. Memory-ready time is not first-token time.",
    measurements,
    providerRequests,
  }, null, 2)}\n`, { flag: "wx" });
});

describe.skipIf(!enabled)("Main to Chat memory growth benchmark", () => {
  it("measures bootstrap, full-source incremental projection and concurrent attempts", async () => {
    const root = await mkdtemp(join(tmpdir(), "idream-memory-pg-growth-"));
    temporary.push(root);
    const canonicalRoot = join(root, "canonical");
    const store = new AttemptWorkspaceStore({ canonicalRoot, privateRoot: join(root, "private") });
    const probe = new IgrepMemoryProbe("igrep");
    let active: Record<string, unknown> = {};
    let prepareStarted = 0;
    let realMaintenance = false;
    let maintenanceCalls = 0;
    let recallCalls = 0;
    const liveAbort = new AbortController();
    if (live) {
      const upstream = process.env.IGREP_LLM_URL;
      if (!upstream || new URL(upstream).origin !== "http://127.0.0.1:8061") throw new Error("Live benchmark requires the inspected local maintenance route");
      const forward = globalThis.fetch.bind(globalThis);
      const proxy = createServer(async (request, response) => {
        const started = performance.now();
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = Buffer.concat(chunks);
        const payload = JSON.parse(body.toString()) as { model?: string };
        const record: Record<string, unknown> = { ordinal: providerRequests.length + 1, path: request.url, model: payload.model,
          requestDigest: createHash("sha256").update(body).digest("hex"), requestBytes: body.byteLength };
        providerRequests.push(record);
        if (providerRequests.length > 4 || liveAbort.signal.aborted) {
          record.blocked = true;
          response.writeHead(429).end("task model budget exceeded");
          liveAbort.abort(new Error("Task model request budget exceeded"));
          return;
        }
        try {
          const result = await forward(new URL(request.url!, upstream).toString(), {
            method: "POST", headers: { "content-type": "application/json", ...(request.headers.authorization ? { authorization: request.headers.authorization } : {}) },
            body, signal: AbortSignal.any([liveAbort.signal, AbortSignal.timeout(60_000)]),
          });
          record.headersMs = round(performance.now() - started);
          record.status = result.status;
          const text = await result.text();
          record.ms = round(performance.now() - started);
          record.responseBytes = Buffer.byteLength(text);
          const returned = JSON.parse(text) as { id?: string; usage?: unknown; model?: string };
          record.requestId = returned.id;
          record.actualModel = returned.model;
          record.usage = returned.usage;
          record.responseDigest = createHash("sha256").update(text).digest("hex");
          response.writeHead(result.status, { "content-type": "application/json" }).end(text);
          if (!result.ok) liveAbort.abort(new Error("Task model request failed"));
        } catch (error) {
          record.failed = true;
          record.ms = round(performance.now() - started);
          response.writeHead(502).end("task model request failed");
          liveAbort.abort(error);
        }
      });
      await new Promise<void>(resolve => proxy.listen(0, "127.0.0.1", resolve));
      const address = proxy.address();
      if (!address || typeof address === "string") throw new Error("Benchmark proxy did not bind");
      const url = `http://127.0.0.1:${address.port}/v1`;
      const previous = { ...process.env };
      for (const name of ["IGREP_LLM_URL", "IGREP_ASK_LLM_URL", "IGREP_EMBEDDING_URL", "IGREP_RERANK_URL"]) process.env[name] = url;
      process.env.IGREP_LLM_EXTRA_BODY = JSON.stringify({ temperature: 0, top_p: 1, presence_penalty: 0 });
      cleanup.push(async () => {
        for (const name of ["IGREP_LLM_URL", "IGREP_ASK_LLM_URL", "IGREP_EMBEDDING_URL", "IGREP_RERANK_URL", "IGREP_LLM_EXTRA_BODY"]) {
          if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name];
        }
        await new Promise<void>((resolve, reject) => proxy.close(error => error ? reject(error) : resolve()));
      });
    }
    const run: RunJsonCommand = async options => {
      const operation = options.args.slice(0, 2).join(" ");
      const started = performance.now();
      if (operation === "mem maintain" && !realMaintenance) {
        active.maintenanceIntercepted = true;
        return { benchmarkOnly: "maintenance scheduling seam; no model executed" };
      }
      if (operation === "mem maintain" && ++maintenanceCalls > 1) throw new Error("Live maintenance budget exceeded");
      const value = await runJsonCommand({ ...options, ...(live ? { signal: liveAbort.signal } : {}),
        ...(operation === "mem maintain" ? { timeoutMs: 120_000 } : {}) });
      const commands = active.commands as Array<Record<string, unknown>>;
      const record = value as Record<string, unknown>;
      commands.push({ operation, ms: round(performance.now() - started), ...(operation === "mem ingest" ? { events: record.events, newEvents: record.newEvents } : {}) });
      if (operation === "mem maintain") active.maintenanceResult = value;
      return value;
    };
    const builder = new IgrepMemoryBuilder("igrep", {
      async status(workspace) {
        const value = await probe.status(workspace);
        active.memoryStatus = value;
        // Explicitly synthetic witness allows measuring the real source path
        // without sending 10k rows through an unbounded profile derivation.
        return realMaintenance ? value : { ...value, lastMaintainAt: "2000-01-01T00:00:00.000Z" };
      },
    }, run);
    downstream.prepare.mockImplementation(async (source: CompanionWorkspaceRebuildSpool) => {
      active.exportAndStageMs = round(performance.now() - prepareStarted);
      active.transcriptBytes = source.estimatedBytes;
      active.messages = source.messageCount;
      active.sessions = source.sessionCount;
      const fingerprints = await timed(async () => {
        const values = [];
        for await (const session of rebuildSpoolSessions(source)) {
          const transcript = await readFile(session.transcriptPath);
          values.push({ messages: session.messageCount, bytes: transcript.byteLength,
            sha256: createHash("sha256").update(transcript).digest("hex") });
        }
        return values;
      });
      active.transcriptFingerprints = fingerprints.value;
      active.benchmarkFingerprintMs = fingerprints.ms;
      const result = await timed(() => store.prepareRelationshipRebuild(source, source.fence!, { seed: source.mode === "project" ? "canonical" : "empty" }, workspace => builder.build(workspace, source)));
      active.workspaceBuildMs = result.ms;
      return result.value;
    });
    downstream.promote.mockImplementation(async (request: CompanionWorkspaceRebuildPromotion) => {
      const result = await timed(() => store.promoteRelationshipRebuild(request));
      active.promoteMs = result.ms;
      return result.value;
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      let request = new Request(url, init);
      if (request.url.endsWith("/prepare")) {
        prepareStarted = performance.now();
        let bytes = 0;
        const body = request.body!.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ transform(chunk, controller) { bytes += chunk.byteLength; controller.enqueue(chunk); } }));
        request = new Request(request, { body, duplex: "half" } as RequestInit);
        const rebuilt = await prepareCompanionMemory(request);
        active.ndjsonBytes = bytes;
        return Response.json({ ok: true, rebuilt });
      }
      return Response.json({ ok: true, rebuilt: await promoteCompanionMemory(request) });
    });

    for (const messages of [100, 1_000, 10_000]) {
      const userId = `${prefix}${messages}-user`;
      const characterId = `${prefix}${messages}-character`;
      const sessionIds = Array.from({ length: messages === 100 ? 2 : 4 }, (_, index) => `${prefix}${messages}-session-${index}`);
      await createUser({ id: userId });
      await createCharacter({ id: characterId, creatorId: userId, source: "user", visibility: "private" });
      await prisma.recentChat.createMany({ data: sessionIds.map(sessionId => ({ sessionId, userId, characterId })) });
      const makeTurn = (index: number) => ({
        id: `${prefix}${messages}-turn-${String(index).padStart(6, "0")}`,
        sessionId: sessionIds[index % sessionIds.length]!, idempotencyKey: `turn-${index}`, requestHash: "a".repeat(64),
        userMessageId: `${prefix}${messages}-user-${index}`, assistantMessageId: `${prefix}${messages}-assistant-${index}`,
        userContent: live && messages === 100 ? "I keep my copper notebook by the cafe window. My favorite drink is jasmine tea."
          : `My copper notebook number is ${index}; I keep it beside the cafe window. ${"The evening light falls across the table. ".repeat(30)}`.slice(0, 1_000),
        assistantContent: live && messages === 100 ? "I remember your notebook by the cafe window and jasmine tea."
          : `You told me about copper notebook ${index} by the cafe window. ${"I remember the warm evening light. ".repeat(35)}`.slice(0, 1_000),
        userStatus: "sent", assistantStatus: "sent", memoryEnabled: true,
        createdAt: new Date(1_700_000_000_000 + index * 1_000), terminalAt: new Date(1_700_000_000_500 + index * 1_000),
      });
      await prisma.chatTurn.createMany({ data: Array.from({ length: messages / 2 }, (_, index) => makeTurn(index)) });
      for (const phase of ["bootstrap", "incremental"] as const) {
        if (phase === "incremental") await prisma.chatTurn.create({ data: makeTurn(messages / 2) });
        active = { baseMessages: messages, phase, commands: [] };
        measurements.push(active);
        realMaintenance = live && messages === 100 && phase === "bootstrap";
        const eventId = await prisma.$transaction(tx => scheduleCompanionMemoryProjection(tx, { userId, characterId }));
        const coalesced = await prisma.$transaction(tx => scheduleCompanionMemoryProjection(tx, { userId, characterId }));
        expect(coalesced).toBe(eventId);
        active.coalescedPendingProjection = true;
        const lag = monitorEventLoopDelay({ resolution: 10 });
        lag.enable();
        const dispatch = await timed(() => dispatchPendingChatEvents({ lane: "memory", deliver: event => syncCompanionMemoryFromMain(durableEventEnvelopeSchema.parse(event)) }));
        lag.disable();
        active.dispatchMs = dispatch.ms;
        active.eventLoopMaxMs = round(lag.max / 1e6);
        active.eventLoopP99Ms = round(lag.percentile(99) / 1e6);
        expect(dispatch.value).toEqual({ delivered: 1, failed: 0 });
        expect(active.messages).toBe(messages + (phase === "incremental" ? 2 : 0));
        if (!live && phase === "incremental") {
          const ingests = (active.commands as Array<Record<string, unknown>>).filter(command => command.operation === "mem ingest");
          expect(ingests.reduce((count, command) => count + Number(command.newEvents), 0)).toBe(2);
        }
        active.canonicalBytes = await treeBytes(join(relationshipWorkspacePath(canonicalRoot, userId, characterId), ".igrep"));
        const attempts = await timed(() => Promise.all(Array.from({ length: 4 }, async (_, index) => {
          const prepared = await timed(() => store.prepare({ userId, characterId, memoryMode: "normal", attemptId: `${phase}-${messages}-${index}` } as CompanionInvocation));
          try {
            const wake = await timed(() => observeIgrepWake("igrep", prepared.value.path));
            return { prepareMs: prepared.ms, wakeMs: wake.ms, wakeOutcome: wake.value.outcome };
          } finally { await prepared.value.discard(); }
        })));
        active.concurrentAttempts = { count: 4, wallMs: attempts.ms, samples: attempts.value };
        if (live && phase === "incremental") {
          if (++recallCalls > 3) throw new Error("Live recall budget exceeded");
          const attempt = await store.prepare({ userId, characterId, memoryMode: "normal", attemptId: `recall-${messages}` } as CompanionInvocation);
          try {
            const recalled = await timed(() => recallIgrepMemory("igrep", attempt.path, "Where do I keep my copper notebook?", { signal: liveAbort.signal }));
            active.recall = { ms: recalled.ms, outcome: recalled.value.outcome, results: recalled.value.resultCount };
          } finally { await attempt.discard(); }
        }
      }
    }
  }, 900_000);
});
