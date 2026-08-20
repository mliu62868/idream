import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  companionReadinessSchema,
  companionRuntimeRequestSchema,
  companionWorkspaceRebuildSchema,
  decodeCompanionWorkspaceRebuildFrame,
  encodeCompanionNdjsonFrame,
  type CompanionInvocation,
  type CompanionMemoryCutoverSidecarProof,
  type CompanionReadiness,
  type CompanionRuntimeRequest,
  type CompanionRuntimeResponse,
  type CompanionWorkspaceRebuild,
} from "@idream/shared/chat/companion-runtime";
import type { WorkspacePurgeRequest } from "./workspace";

const MAX_CONTROL_BODY_BYTES = 1_048_576;
// A durable Chat message is bounded independently; only the aggregate rebuild
// is intentionally unbounded so old relationships remain privacy-rebuildable.
const MAX_REBUILD_FRAME_BYTES = 256 * 1_024;

type ControlFrame = Exclude<CompanionRuntimeRequest, { type: "run" }>;

export interface InvocationService {
  run(
    invocation: CompanionInvocation,
    emit: (frame: CompanionRuntimeResponse) => void,
  ): Promise<void>;
  accept(frame: ControlFrame): Promise<void>;
  purge(request: WorkspacePurgeRequest): Promise<number>;
  rebuild(request: CompanionWorkspaceRebuild): Promise<{ sessions: number; messages: number }>;
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
}

export interface CompanionServer {
  readonly http: Server;
  close(): Promise<void>;
}

function tokenDigest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function isAuthorized(request: IncomingMessage, expectedDigest: Buffer): boolean {
  const header = request.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  return timingSafeEqual(tokenDigest(header.slice("Bearer ".length)), expectedDigest);
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(`${JSON.stringify(value)}\n`);
}

function failure(response: ServerResponse, status: number, code: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  json(response, status, { error: { code, message } });
}

async function readJson(
  request: IncomingMessage,
  maxBytes = MAX_CONTROL_BODY_BYTES,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > maxBytes) throw new Error(`request body exceeds ${maxBytes} bytes`);
    chunks.push(buffer);
  }
  if (size === 0) throw new Error("request body is required");
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function* readNdjsonLines(request: IncomingMessage): AsyncGenerator<string> {
  let pending = Buffer.alloc(0);
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
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
  if (pending.byteLength > 0) yield pending.toString("utf8");
}

async function readWorkspaceRebuild(request: IncomingMessage): Promise<CompanionWorkspaceRebuild> {
  if (request.headers["content-type"]?.split(";", 1)[0]?.trim() !== "application/x-ndjson") {
    throw new Error("relationship rebuild requires application/x-ndjson");
  }
  let start: Extract<
    ReturnType<typeof decodeCompanionWorkspaceRebuildFrame>,
    { type: "start" }
  > | undefined;
  let complete = false;
  const messages: CompanionWorkspaceRebuild["messages"] = [];
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
    if (frame.type === "message") {
      if (messages.length >= start.messageCount) {
        throw new Error("relationship rebuild exceeds its declared message count");
      }
      messages.push(frame.message);
      continue;
    }
    if (frame.messageCount !== start.messageCount || messages.length !== start.messageCount) {
      throw new Error("relationship rebuild completed with a mismatched message count");
    }
    complete = true;
  }
  if (!start) throw new Error("relationship rebuild start frame is required");
  if (!complete) throw new Error("relationship rebuild complete frame is required");
  return companionWorkspaceRebuildSchema.parse({
    scope: start.scope,
    userId: start.userId,
    characterId: start.characterId,
    messages,
  });
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

export function createCompanionServer(options: CompanionServerOptions): CompanionServer {
  if (!options.authToken) throw new Error("companion auth token is required");
  const expectedDigest = tokenDigest(options.authToken);
  let closing = false;

  const http = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://sidecar.local");
      if (request.method === "GET" && url.pathname === "/healthz") {
        json(response, 200, { ok: true });
        return;
      }

      if ((url.pathname === "/readyz" || url.pathname.startsWith("/v1/"))
        && !isAuthorized(request, expectedDigest)) {
        json(response, 401, { error: { code: "unauthorized", message: "unauthorized" } });
        return;
      }

      if (request.method === "GET" && url.pathname === "/readyz") {
        if (closing) {
          failure(response, 503, "shutting_down", new Error("sidecar is shutting down"));
          return;
        }
        try {
          const ready = companionReadinessSchema.parse(
            await options.readiness(url.searchParams.get("full") === "1"),
          );
          json(response, 200, ready);
        } catch (error) {
          failure(response, 503, "not_ready", error);
        }
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/invocations") {
        if (closing) {
          failure(response, 503, "shutting_down", new Error("sidecar is shutting down"));
          return;
        }
        const frame = companionRuntimeRequestSchema.parse(await readJson(request));
        if (frame.type !== "run") throw new Error("POST /v1/invocations requires a run frame");
        response.writeHead(200, {
          "content-type": "application/x-ndjson; charset=utf-8",
          "cache-control": "no-store",
          connection: "keep-alive",
        });
        response.flushHeaders();
        let running = true;
        const cancelOnDisconnect = () => {
          if (!running) return;
          void options.invocation.accept({
            protocolVersion: 1,
            type: "cancel",
            invocationId: frame.invocation.invocationId,
            reason: "user",
          }).catch(() => undefined);
        };
        response.once("close", cancelOnDisconnect);
        try {
          await options.invocation.run(frame.invocation, (outbound) => {
            if (!response.destroyed && !response.writableEnded) {
              response.write(encodeCompanionNdjsonFrame(outbound));
            }
          });
        } finally {
          running = false;
          response.removeListener("close", cancelOnDisconnect);
        }
        response.end();
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/workspaces/purge") {
        if (closing) {
          failure(response, 503, "shutting_down", new Error("sidecar is shutting down"));
          return;
        }
        const purged = await options.invocation.purge(purgeRequest(await readJson(request)));
        json(response, 200, { ok: true, purged });
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/workspaces/rebuild") {
        if (closing) {
          failure(response, 503, "shutting_down", new Error("sidecar is shutting down"));
          return;
        }
        const rebuilt = await options.invocation.rebuild(await readWorkspaceRebuild(request));
        json(response, 200, { ok: true, rebuilt });
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/workspaces/memory-cutover-proof") {
        if (closing) {
          failure(response, 503, "shutting_down", new Error("sidecar is shutting down"));
          return;
        }
        const relationship = relationshipRequest(await readJson(request));
        const proof = await options.invocation.memoryCutoverProof({
          userId: relationship.userId,
          characterId: relationship.characterId,
        });
        json(response, 200, { ok: true, proof });
        return;
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
        json(response, 200, { ok: true });
        return;
      }

      json(response, 404, { error: { code: "not_found", message: "not found" } });
    } catch (error) {
      if (!response.headersSent) failure(response, 400, "invalid_request", error);
      else response.destroy(error instanceof Error ? error : new Error(String(error)));
    }
  });

  return {
    http,
    async close() {
      if (closing) return;
      closing = true;
      await options.invocation.shutdown();
      if (!http.listening) return;
      await new Promise<void>((resolve, reject) => {
        http.close((error) => error ? reject(error) : resolve());
        http.closeIdleConnections();
      });
    },
  };
}
