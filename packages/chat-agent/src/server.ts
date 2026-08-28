import { createHash, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, mkdtemp, open, rm, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  companionReadinessSchema,
  companionRuntimeRequestSchema,
  companionWorkspaceRebuildFenceSchema,
  companionWorkspaceRebuildPromotionSchema,
  decodeCompanionWorkspaceRebuildFrame,
  encodeCompanionNdjsonFrame,
  type CompanionInvocation,
  type CompanionMemoryCutoverSidecarProof,
  type CompanionReadiness,
  type CompanionRuntimeRequest,
  type CompanionRuntimeResponse,
} from "@idream/shared/chat/companion-runtime";
import type {
  CompanionWorkspaceRebuildPromotion,
  CompanionWorkspaceRebuildSource,
  CompanionWorkspaceRebuildSpool,
} from "./rebuild-source";
import type { WorkspacePurgeRequest } from "./workspace";

const MAX_CONTROL_BODY_BYTES = 1_048_576;
// Content is carried in Shared-owned 16Ki-character chunks, making the frame
// cap independent of the unbounded durable message and relationship sizes.
const MAX_REBUILD_FRAME_BYTES = 256 * 1_024;

interface BunHttpServer {
  readonly port: number | undefined;
  readonly url: URL;
  timeout(request: Request, seconds: number): void;
  stop(closeActiveConnections?: boolean): Promise<void>;
}

declare const Bun: {
  serve(options: {
    hostname?: string;
    port?: number;
    fetch(request: Request, server: BunHttpServer): Response | Promise<Response>;
  }): BunHttpServer;
};

type ControlFrame = Exclude<CompanionRuntimeRequest, { type: "run" }>;

export interface InvocationService {
  run(
    invocation: CompanionInvocation,
    emit: (frame: CompanionRuntimeResponse) => void,
  ): Promise<void>;
  accept(frame: ControlFrame): Promise<void>;
  purge(request: WorkspacePurgeRequest): Promise<number>;
  rebuild(
    request: CompanionWorkspaceRebuildSource,
    signal?: AbortSignal,
  ): Promise<{ sessions: number; messages: number }>;
  prepareRebuild(
    request: CompanionWorkspaceRebuildSource,
    signal?: AbortSignal,
  ): Promise<{ rebuildId: string; sessions: number; messages: number }>;
  promoteRebuild(
    request: CompanionWorkspaceRebuildPromotion,
    signal?: AbortSignal,
  ): Promise<{ sessions: number; messages: number }>;
  discardRebuild(request: CompanionWorkspaceRebuildPromotion): Promise<void>;
  memoryCutoverProof(request: {
    userId: string;
    characterId: string;
  }): Promise<CompanionMemoryCutoverSidecarProof | null>;
  shutdown(): Promise<void>;
}

export interface CompanionServerOptions {
  authToken: string;
  readiness(force?: boolean): Promise<CompanionReadiness>;
  invocation: InvocationService;
  rebuildSpoolRoot?: string;
  hostname?: string;
  port?: number;
}

export interface CompanionServer {
  readonly http: BunHttpServer;
  close(): Promise<void>;
}

function tokenDigest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function isAuthorized(request: Request, expectedDigest: Buffer): boolean {
  const header = request.headers.get("authorization");
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  return timingSafeEqual(tokenDigest(header.slice("Bearer ".length)), expectedDigest);
}

function json(status: number, value: unknown): Response {
  return new Response(`${JSON.stringify(value)}\n`, {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function failure(status: number, code: string, error: unknown): Response {
  const message = error instanceof Error ? error.message : String(error);
  return json(status, { error: { code, message } });
}

async function readJson(
  request: Request,
  maxBytes = MAX_CONTROL_BODY_BYTES,
): Promise<unknown> {
  if (!request.body) throw new Error("request body is required");
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let body = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error(`request body exceeds ${maxBytes} bytes`);
      body += decoder.decode(value, { stream: true });
    }
    body += decoder.decode();
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  if (size === 0) throw new Error("request body is required");
  return JSON.parse(body);
}

async function* readNdjsonLines(request: Request): AsyncGenerator<string> {
  if (!request.body) throw new Error("request body is required");
  const reader = request.body.getReader();
  let pending = Buffer.alloc(0);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const buffer = Buffer.from(value);
      pending = pending.byteLength === 0 ? buffer : Buffer.concat([pending, buffer]);
      let delimiter = pending.indexOf(0x0a);
      while (delimiter >= 0) {
        if (delimiter > MAX_REBUILD_FRAME_BYTES) {
          throw new Error(`relationship rebuild frame exceeds ${MAX_REBUILD_FRAME_BYTES} bytes`);
        }
        yield pending.subarray(0, delimiter + 1).toString("utf8");
        pending = pending.subarray(delimiter + 1);
        delimiter = pending.indexOf(0x0a);
      }
      if (pending.byteLength > MAX_REBUILD_FRAME_BYTES) {
        throw new Error(`relationship rebuild frame exceeds ${MAX_REBUILD_FRAME_BYTES} bytes`);
      }
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  if (pending.byteLength > 0) yield pending.toString("utf8");
}

interface StagedWorkspaceRebuild {
  source: CompanionWorkspaceRebuildSpool;
  dispose(): Promise<void>;
}

async function stageWorkspaceRebuild(
  request: Request,
  spoolBase: string,
): Promise<StagedWorkspaceRebuild> {
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "application/x-ndjson") {
    throw new Error("relationship rebuild requires application/x-ndjson");
  }
  await mkdir(spoolBase, { recursive: true, mode: 0o700 });
  await chmod(spoolBase, 0o700);
  const spoolRoot = await mkdtemp(join(spoolBase, "request-"));
  await chmod(spoolRoot, 0o700);
  const manifestPath = join(spoolRoot, "manifest.jsonl");
  const manifest = await open(manifestPath, "wx", 0o600);
  let start: Extract<
    ReturnType<typeof decodeCompanionWorkspaceRebuildFrame>,
    { type: "start" }
  > | undefined;
  let complete = false;
  let messages = 0;
  let sessions = 0;
  let estimatedBytes = 0;
  let transcript: FileHandle | undefined;
  let currentSession: {
    id: string;
    path: string;
    messages: number;
    bytes: number;
    expectedRole: "user" | "assistant";
  } | undefined;
  let activeMessage: {
    contentLength: number;
    received: number;
    createdAt: string;
  } | undefined;
  const seenSessions = new Set<string>();
  const writeTranscript = async (value: string) => {
    if (!transcript || !currentSession) throw new Error("relationship transcript is not open");
    await transcript.write(value);
    const bytes = Buffer.byteLength(value);
    currentSession.bytes += bytes;
    estimatedBytes += bytes;
  };
  const finishSession = async () => {
    if (!currentSession) return;
    if (activeMessage || currentSession.expectedRole !== "user") {
      throw new Error(`relationship rebuild session ${currentSession.id} has an incomplete exchange`);
    }
    await transcript?.sync();
    await transcript?.close();
    transcript = undefined;
    await manifest.write(`${JSON.stringify({
      sessionId: currentSession.id,
      transcriptPath: currentSession.path,
      messageCount: currentSession.messages,
      estimatedBytes: currentSession.bytes,
    })}\n`);
    sessions += 1;
    currentSession = undefined;
  };
  try {
    for await (const line of readNdjsonLines(request)) {
      const frame = decodeCompanionWorkspaceRebuildFrame(line);
      if (!start) {
        if (frame.type !== "start") {
          throw new Error("relationship rebuild must start with a start frame");
        }
        start = frame;
        continue;
      }
      if (complete) throw new Error("relationship rebuild has frames after completion");
      if (frame.type === "start") throw new Error("relationship rebuild has multiple start frames");
      if (frame.type === "message_start") {
        if (activeMessage) throw new Error("relationship rebuild message is already open");
        if (messages >= start.messageCount) {
          throw new Error("relationship rebuild exceeds its declared message count");
        }
        if (currentSession?.id !== frame.message.sessionId) {
          await finishSession();
          if (seenSessions.has(frame.message.sessionId)) {
            throw new Error("relationship rebuild sessions must be contiguous");
          }
          seenSessions.add(frame.message.sessionId);
          const digest = createHash("sha256").update(frame.message.sessionId).digest("hex");
          const path = join(spoolRoot, `session-${digest}.jsonl`);
          transcript = await open(path, "wx", 0o600);
          currentSession = {
            id: frame.message.sessionId,
            path,
            messages: 0,
            bytes: 0,
            expectedRole: "user",
          };
        }
        if (frame.message.role !== currentSession.expectedRole) {
          throw new Error(
            `relationship rebuild expected ${currentSession.expectedRole} message`,
          );
        }
        activeMessage = {
          contentLength: frame.contentLength,
          received: 0,
          createdAt: frame.message.createdAt,
        };
        await writeTranscript(
          `{"role":${JSON.stringify(frame.message.role)},"content":"`,
        );
        continue;
      }
      if (frame.type === "content_chunk") {
        if (!activeMessage) throw new Error("relationship rebuild content has no open message");
        activeMessage.received += frame.content.length;
        if (activeMessage.received > activeMessage.contentLength) {
          throw new Error("relationship rebuild content exceeds its declared length");
        }
        await writeTranscript(JSON.stringify(frame.content).slice(1, -1));
        continue;
      }
      if (frame.type === "message_complete") {
        if (!activeMessage || !currentSession) {
          throw new Error("relationship rebuild has no message to complete");
        }
        if (activeMessage.received !== activeMessage.contentLength) {
          throw new Error("relationship rebuild content length is incomplete");
        }
        await writeTranscript(
          `","source_at":${JSON.stringify(activeMessage.createdAt)},"source_timezone":"UTC"}\n`,
        );
        currentSession.messages += 1;
        currentSession.expectedRole = currentSession.expectedRole === "user"
          ? "assistant"
          : "user";
        activeMessage = undefined;
        messages += 1;
        continue;
      }
      if (activeMessage) throw new Error("relationship rebuild completed inside a message");
      if (frame.messageCount !== start.messageCount || messages !== start.messageCount) {
        throw new Error("relationship rebuild completed with a mismatched message count");
      }
      await finishSession();
      complete = true;
    }
    if (!start) throw new Error("relationship rebuild start frame is required");
    if (!complete) throw new Error("relationship rebuild complete frame is required");
    await manifest.sync();
    await manifest.close();
    return {
      source: {
        kind: "spool",
        scope: "relationship",
        userId: start.userId,
        characterId: start.characterId,
        messageCount: messages,
        sessionCount: sessions,
        estimatedBytes,
        manifestPath,
        ...(start.fence ? { fence: start.fence } : {}),
      },
      dispose: () => rm(spoolRoot, { recursive: true, force: true }),
    };
  } catch (error) {
    await transcript?.close().catch(() => undefined);
    await manifest.close().catch(() => undefined);
    await rm(spoolRoot, { recursive: true, force: true });
    throw error;
  }
}

function controlRoute(pathname: string): { invocationId: string; type: ControlFrame["type"] } | undefined {
  const match = /^\/v1\/invocations\/([^/]+)\/(tool-result|commit|cancel)$/.exec(pathname);
  if (!match) return undefined;
  const invocationId = decodeURIComponent(match[1] ?? "");
  const suffix = match[2];
  const type = suffix === "tool-result" ? "tool_result" : suffix === "commit" ? "commit_ack" : "cancel";
  return { invocationId, type };
}

function purgeRequest(value: unknown): WorkspacePurgeRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("workspace purge body must be an object");
  }
  const record = value as Record<string, unknown>;
  const userId = typeof record.userId === "string" ? record.userId.trim() : "";
  if (!userId) throw new Error("workspace purge userId must be a non-empty string");
  if (record.scope === "user") {
    if (Object.keys(record).sort().join(",") !== "scope,userId") {
      throw new Error("user workspace purge accepts only scope and userId");
    }
    return { scope: "user", userId };
  }
  if (record.scope === "relationship") {
    const characterId = typeof record.characterId === "string" ? record.characterId.trim() : "";
    if (!characterId) throw new Error("relationship purge characterId must be a non-empty string");
    if (Object.keys(record).sort().join(",") !== "characterId,scope,userId") {
      throw new Error("relationship workspace purge accepts only scope, userId and characterId");
    }
    return { scope: "relationship", userId, characterId };
  }
  throw new Error("workspace purge scope must be user or relationship");
}

function relationshipRequest(value: unknown): {
  userId: string;
  characterId: string;
} {
  const parsed = purgeRequest(value);
  if (parsed.scope !== "relationship") {
    throw new Error("relationship workspace identity is required");
  }
  return parsed;
}

function rebuildPromotionRequest(value: unknown): CompanionWorkspaceRebuildPromotion {
  return companionWorkspaceRebuildPromotionSchema.parse(value);
}

function isAdmissionRequest(method: string, pathname: string): boolean {
  return (method === "GET" && pathname === "/readyz") ||
    (method === "POST" && (
      pathname === "/v1/invocations" ||
      pathname === "/v1/workspaces/purge" ||
      pathname === "/v1/workspaces/rebuild/prepare" ||
      pathname === "/v1/workspaces/rebuild/promote" ||
      pathname === "/v1/workspaces/rebuild/discard" ||
      pathname === "/v1/workspaces/memory-cutover-proof"
    ));
}

export function createCompanionServer(options: CompanionServerOptions): CompanionServer {
  if (!options.authToken) throw new Error("companion auth token is required");
  const expectedDigest = tokenDigest(options.authToken);
  let closing = false;

  const handleRequest = async (
    request: Request,
    server: BunHttpServer,
  ): Promise<Response> => {
    try {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/healthz") {
        return json(200, { ok: true });
      }

      if ((url.pathname === "/readyz" || url.pathname.startsWith("/v1/"))
        && !isAuthorized(request, expectedDigest)) {
        return json(401, { error: { code: "unauthorized", message: "unauthorized" } });
      }

      if (closing && isAdmissionRequest(request.method, url.pathname)) {
        return failure(503, "shutting_down", new Error("sidecar is shutting down"));
      }

      if (request.method === "GET" && url.pathname === "/readyz") {
        if (url.searchParams.get("full") === "1") {
          // Full readiness runs bounded provider/composition/lifecycle probes.
          // Keep it finite while allowing the observed ~20s cold verification.
          server.timeout(request, 30);
        }
        try {
          const ready = companionReadinessSchema.parse(
            await options.readiness(url.searchParams.get("full") === "1"),
          );
          return json(200, ready);
        } catch (error) {
          return failure(503, "not_ready", error);
        }
      }

      if (request.method === "POST" && url.pathname === "/v1/invocations") {
        // SPEC: only the authenticated long-lived NDJSON response disables
        // Bun's request timeout. Ordinary JSON/readiness requests stay finite.
        server.timeout(request, 0);
        const frame = companionRuntimeRequestSchema.parse(await readJson(request));
        if (frame.type !== "run") throw new Error("POST /v1/invocations requires a run frame");
        let running = true;
        let cancelled = false;
        const encoder = new TextEncoder();
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            void Promise.resolve().then(() => options.invocation.run(
              frame.invocation,
              (outbound) => {
                if (!cancelled) {
                  controller.enqueue(encoder.encode(encodeCompanionNdjsonFrame(outbound)));
                }
              },
            )).then(
              () => {
                running = false;
                if (!cancelled) controller.close();
              },
              (error) => {
                running = false;
                if (!cancelled) controller.error(error);
              },
            );
          },
          async cancel() {
            cancelled = true;
            if (!running) return;
            await options.invocation.accept({
              protocolVersion: 1,
              type: "cancel",
              invocationId: frame.invocation.invocationId,
              reason: "user",
            }).catch(() => undefined);
          },
        });
        return new Response(body, {
          status: 200,
          headers: {
            "content-type": "application/x-ndjson; charset=utf-8",
            "cache-control": "no-store",
            connection: "keep-alive",
          },
        });
      }

      if (request.method === "POST" && url.pathname === "/v1/workspaces/purge") {
        const purged = await options.invocation.purge(purgeRequest(await readJson(request)));
        return json(200, { ok: true, purged });
      }

      if (request.method === "POST" && url.pathname === "/v1/workspaces/rebuild/prepare") {
        // The rebuild upload is a bounded-frame NDJSON stream whose aggregate
        // size is intentionally unbounded; its domain abort signal owns time.
        server.timeout(request, 0);
        const staged = await stageWorkspaceRebuild(
          request,
          options.rebuildSpoolRoot ?? join(tmpdir(), "idream-chat-rebuilds"),
        );
        const controller = new AbortController();
        const abortOnDisconnect = () => {
          controller.abort(new Error("relationship rebuild client disconnected"));
        };
        if (request.signal.aborted) abortOnDisconnect();
        else request.signal.addEventListener("abort", abortOnDisconnect, { once: true });
        const rebuilt = await (async () => {
          try {
            if (!staged.source.fence) {
              throw new Error("relationship rebuild prepare requires a projection fence");
            }
            const result = await options.invocation.prepareRebuild(
              staged.source,
              controller.signal,
            );
            return result;
          } finally {
            request.signal.removeEventListener("abort", abortOnDisconnect);
            await staged.dispose();
          }
        })();
        // INVARIANT: a successful response acknowledges a fully verified staged
        // candidate and removal of the request-owned plaintext spool. It does
        // not promote; Chat must still pass the final DB authority fence.
        return json(200, { ok: true, rebuilt });
      }

      if (request.method === "POST" && (
        url.pathname === "/v1/workspaces/rebuild/promote"
        || url.pathname === "/v1/workspaces/rebuild/discard"
      )) {
        const promotion = rebuildPromotionRequest(await readJson(request));
        if (url.pathname.endsWith("/discard")) {
          await options.invocation.discardRebuild(promotion);
          return json(200, { ok: true });
        } else {
          const controller = new AbortController();
          const abortOnDisconnect = () => {
            controller.abort(new Error("relationship promotion client disconnected"));
          };
          if (request.signal.aborted) abortOnDisconnect();
          else request.signal.addEventListener("abort", abortOnDisconnect, { once: true });
          try {
            const rebuilt = await options.invocation.promoteRebuild(
              promotion,
              controller.signal,
            );
            return json(200, { ok: true, rebuilt });
          } finally {
            request.signal.removeEventListener("abort", abortOnDisconnect);
          }
        }
      }

      if (request.method === "POST" && url.pathname === "/v1/workspaces/memory-cutover-proof") {
        const relationship = relationshipRequest(await readJson(request));
        const proof = await options.invocation.memoryCutoverProof({
          userId: relationship.userId,
          characterId: relationship.characterId,
        });
        return json(200, { ok: true, proof });
      }
      const route = request.method === "POST" ? controlRoute(url.pathname) : undefined;
      if (route) {
        const frame = companionRuntimeRequestSchema.parse(await readJson(request));
        if (frame.type === "run" || frame.type !== route.type) {
          throw new Error(`endpoint requires a ${route.type} frame`);
        }
        if (frame.invocationId !== route.invocationId) {
          throw new Error("path and frame invocation ids must match");
        }
        await options.invocation.accept(frame);
        return json(200, { ok: true });
      }

      return json(404, { error: { code: "not_found", message: "not found" } });
    } catch (error) {
      return failure(400, "invalid_request", error);
    }
  };

  const http = Bun.serve({
    ...(options.hostname ? { hostname: options.hostname } : {}),
    ...(options.port !== undefined ? { port: options.port } : {}),
    fetch: handleRequest,
  });

  return {
    http,
    async close() {
      if (closing) return;
      closing = true;
      await options.invocation.shutdown();
      await http.stop(true);
    },
  };
}
