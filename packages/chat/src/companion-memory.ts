import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, open, rm, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  companionWorkspaceRebuildPromotionSchema,
  decodeCompanionWorkspaceRebuildFrame,
} from "@idream/shared/chat/companion-runtime";
import {
  prepareCompanionWorkspaceRebuild,
  promoteCompanionWorkspaceRebuild,
  purgeCompanionWorkspace,
} from "./agent-runtime/runtime.js";
import type { CompanionWorkspaceRebuildSpool } from "./agent-runtime/rebuild-source.js";
import type { WorkspacePurgeRequest } from "./agent-runtime/workspace.js";

const MAX_CONTROL_BODY_BYTES = 1_048_576;
const MAX_REBUILD_FRAME_BYTES = 256 * 1_024;
const TRANSCRIPT_BUFFER_BYTES = 64 * 1_024;

async function readJson(request: Request): Promise<unknown> {
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
      if (size > MAX_CONTROL_BODY_BYTES) {
        throw new Error(`request body exceeds ${MAX_CONTROL_BODY_BYTES} bytes`);
      }
      body += decoder.decode(value, { stream: true });
    }
    body += decoder.decode();
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
  } finally {
    reader.releaseLock();
  }
  if (pending.byteLength > 0) yield pending.toString("utf8");
}

interface StagedWorkspaceRebuild {
  source: CompanionWorkspaceRebuildSpool;
  dispose(): Promise<void>;
}

async function stageWorkspaceRebuild(request: Request): Promise<StagedWorkspaceRebuild> {
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "application/x-ndjson") {
    throw new Error("relationship rebuild requires application/x-ndjson");
  }
  const spoolBase = join(tmpdir(), "idream-chat-rebuilds");
  await mkdir(spoolBase, { recursive: true, mode: 0o700 });
  await chmod(spoolBase, 0o700);
  const spoolRoot = await mkdtemp(join(spoolBase, "request-"));
  await chmod(spoolRoot, 0o700);
  const manifestPath = join(spoolRoot, "manifest.jsonl");
  const manifest = await open(manifestPath, "wx", 0o600);
  let start: Extract<ReturnType<typeof decodeCompanionWorkspaceRebuildFrame>, { type: "start" }> | undefined;
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
  let activeMessage: { contentLength: number; received: number; createdAt: string } | undefined;
  const seenSessions = new Set<string>();
  const transcriptBuffer = Buffer.allocUnsafe(TRANSCRIPT_BUFFER_BYTES);
  let bufferedBytes = 0;
  const flushTranscript = async () => {
    if (!transcript) throw new Error("relationship transcript is not open");
    let offset = 0;
    while (offset < bufferedBytes) {
      const { bytesWritten } = await transcript.write(transcriptBuffer, offset, bufferedBytes - offset);
      if (bytesWritten === 0) throw new Error("relationship transcript write made no progress");
      offset += bytesWritten;
    }
    bufferedBytes = 0;
  };
  const writeTranscript = async (value: string) => {
    if (!transcript || !currentSession) throw new Error("relationship transcript is not open");
    const encoded = Buffer.from(value);
    // Bound staging memory while avoiding a filesystem write for every protocol fragment.
    // Flush before each session's fsync so no buffered bytes can cross session boundaries.
    let offset = 0;
    while (offset < encoded.byteLength) {
      const copied = encoded.copy(transcriptBuffer, bufferedBytes, offset);
      bufferedBytes += copied;
      offset += copied;
      if (bufferedBytes === transcriptBuffer.byteLength) await flushTranscript();
    }
    const bytes = encoded.byteLength;
    currentSession.bytes += bytes;
    estimatedBytes += bytes;
  };
  const finishSession = async () => {
    if (!currentSession) return;
    if (activeMessage || currentSession.expectedRole !== "user") {
      throw new Error(`relationship rebuild session ${currentSession.id} has an incomplete exchange`);
    }
    await flushTranscript();
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
        if (frame.type !== "start") throw new Error("relationship rebuild must start with a start frame");
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
          throw new Error(`relationship rebuild expected ${currentSession.expectedRole} message`);
        }
        activeMessage = {
          contentLength: frame.contentLength,
          received: 0,
          createdAt: frame.message.createdAt,
        };
        await writeTranscript(`{"role":${JSON.stringify(frame.message.role)},"content":"`);
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
        if (!activeMessage || !currentSession) throw new Error("relationship rebuild has no message to complete");
        if (activeMessage.received !== activeMessage.contentLength) {
          throw new Error("relationship rebuild content length is incomplete");
        }
        await writeTranscript(
          `","source_at":${JSON.stringify(activeMessage.createdAt)},"source_timezone":"UTC"}\n`,
        );
        currentSession.messages += 1;
        currentSession.expectedRole = currentSession.expectedRole === "user" ? "assistant" : "user";
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
    if (!start.fence) throw new Error("relationship rebuild prepare requires a projection fence");
    await manifest.sync();
    await manifest.close();
    return {
      source: {
        kind: "spool",
        scope: "relationship",
        userId: start.userId,
        characterId: start.characterId,
        mode: start.mode,
        messageCount: messages,
        sessionCount: sessions,
        estimatedBytes,
        manifestPath,
        fence: start.fence,
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

function purgeRequest(value: unknown): WorkspacePurgeRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("workspace purge body must be an object");
  }
  const record = value as Record<string, unknown>;
  const userId = typeof record.userId === "string" ? record.userId.trim() : "";
  if (!userId) throw new Error("workspace purge userId must be a non-empty string");
  if (record.scope === "user" && Object.keys(record).sort().join(",") === "scope,userId") {
    return { scope: "user", userId };
  }
  if (record.scope === "relationship") {
    const characterId = typeof record.characterId === "string" ? record.characterId.trim() : "";
    if (characterId && Object.keys(record).sort().join(",") === "characterId,scope,userId") {
      return { scope: "relationship", userId, characterId };
    }
  }
  throw new Error("workspace purge body is invalid");
}

export async function purgeCompanionMemory(request: Request) {
  return purgeCompanionWorkspace(purgeRequest(await readJson(request)));
}

export async function prepareCompanionMemory(request: Request) {
  const staged = await stageWorkspaceRebuild(request);
  try {
    return await prepareCompanionWorkspaceRebuild(staged.source, request.signal);
  } finally {
    await staged.dispose();
  }
}

export async function promoteCompanionMemory(request: Request) {
  const promotion = companionWorkspaceRebuildPromotionSchema.parse(await readJson(request));
  return promoteCompanionWorkspaceRebuild(promotion, request.signal);
}
