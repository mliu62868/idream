import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  BFF_HEADER,
  BFF_USER_HEADER,
  signBffContext,
} from "@idream/shared/bff";

type ProbeOptions = {
  report: string | null;
  serviceUrl: string | null;
  userId: string;
  characterId: string | null;
};

type OperationEvidence = {
  ok: boolean;
  status?: number;
  error?: string | null;
};

// End-to-end conversation smoke (design §10.4): create → send → stream → get,
// plus a no-memory smoke and a blocked-input smoke. Each sub-step carries its own
// evidence so a failure is diagnosable from the report alone.
type ConversationEvidence = {
  ok: boolean;
  attempted: boolean;
  createSession: OperationEvidence;
  sendMessage: OperationEvidence;
  stream: OperationEvidence & { sawStart?: boolean; sawDelta?: boolean; sawDone?: boolean };
  getSession: OperationEvidence & { assistantSent?: boolean };
  noMemory: OperationEvidence;
  blockedInput: OperationEvidence & { status_?: string };
  error?: string | null;
};

type ChatServiceProbeReport = {
  ok: boolean;
  checkedAt: string;
  durationMs: number;
  serviceUrl: string | null;
  userId: string;
  usedSignedBff: boolean;
  health: OperationEvidence & { service?: string | null };
  signedRequest: OperationEvidence & { sessionsCount?: number };
  unsignedRequest: OperationEvidence;
  conversation: ConversationEvidence;
  error: { code: string; message: string; retryable?: boolean } | null;
};

function readArg(name: string) {
  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function readOptions(): ProbeOptions {
  return {
    report: readArg("report") ?? process.env.CHAT_SERVICE_PROBE_REPORT ?? null,
    serviceUrl: readArg("service-url") ?? process.env.CHAT_SERVICE_URL ?? null,
    userId: readArg("user-id") ?? process.env.CHAT_SERVICE_PROBE_USER_ID ?? "seed-dev-user",
    characterId: readArg("character-id") ?? process.env.CHAT_SERVICE_PROBE_CHARACTER_ID ?? null,
  };
}

async function main() {
  const options = readOptions();
  const report = await runProbe({
    serviceUrl: options.serviceUrl,
    userId: options.userId,
    characterId: options.characterId,
    secret: process.env.CHAT_BFF_SIGNING_SECRET ?? null,
  });

  if (options.report) {
    const reportPath = resolveWorkspacePath(options.report);
    await mkdir(path.dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  }

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) process.exitCode = 1;
}

const SKIPPED_OP: OperationEvidence = { ok: true, error: "skipped" };

function skippedConversation(reason: string): ConversationEvidence {
  return {
    ok: true,
    attempted: false,
    createSession: SKIPPED_OP,
    sendMessage: SKIPPED_OP,
    stream: SKIPPED_OP,
    getSession: SKIPPED_OP,
    noMemory: SKIPPED_OP,
    blockedInput: SKIPPED_OP,
    error: reason,
  };
}

async function runProbe(input: {
  serviceUrl: string | null;
  userId: string;
  characterId: string | null;
  secret: string | null;
}): Promise<ChatServiceProbeReport> {
  const checkedAt = new Date().toISOString();
  const startedAt = Date.now();
  const baseReport = {
    checkedAt,
    serviceUrl: input.serviceUrl,
    userId: input.userId,
    usedSignedBff: Boolean(input.secret?.trim()),
  };

  const health = await probeHealth(input.serviceUrl);
  let signedRequest: ChatServiceProbeReport["signedRequest"] = {
    ok: false,
    error: "CHAT_BFF_SIGNING_SECRET is required for chat service probe",
  };
  let unsignedRequest: ChatServiceProbeReport["unsignedRequest"] = {
    ok: false,
    error: "not attempted",
  };
  let conversation: ConversationEvidence = skippedConversation(
    "CHAT_SERVICE_PROBE_CHARACTER_ID not set — conversation smoke skipped",
  );

  try {
    if (!input.serviceUrl?.trim()) {
      throw new Error("CHAT_SERVICE_URL is required for chat service probe");
    }
    if (!input.secret?.trim()) {
      throw new Error("CHAT_BFF_SIGNING_SECRET is required for chat service probe");
    }

    signedRequest = await probeSignedSessions({
      serviceUrl: input.serviceUrl,
      secret: input.secret,
      userId: input.userId,
    });
    unsignedRequest = await probeUnsignedSessions(input.serviceUrl);
    if (input.characterId?.trim()) {
      conversation = await probeConversation({
        serviceUrl: input.serviceUrl,
        secret: input.secret,
        userId: input.userId,
        characterId: input.characterId,
      });
    }
  } catch (error) {
    return {
      ...baseReport,
      ok: false,
      durationMs: Date.now() - startedAt,
      health,
      signedRequest,
      unsignedRequest,
      conversation,
      error: {
        code: "chat_service_probe_failed",
        message: error instanceof Error ? error.message : String(error),
        retryable: true,
      },
    };
  }

  const ok =
    health.ok &&
    signedRequest.ok &&
    unsignedRequest.status === 401 &&
    conversation.ok &&
    Boolean(input.secret?.trim());

  return {
    ...baseReport,
    ok,
    durationMs: Date.now() - startedAt,
    health,
    signedRequest,
    unsignedRequest,
    conversation,
    error: ok
      ? null
      : {
          code: "chat_service_probe_failed",
          message: "chat service health, signed request, unsigned rejection, or conversation smoke failed",
          retryable: true,
        },
  };
}

/** Make a signed BFF request to the chat service (signature covers method+path+body). */
async function signedFetch(input: {
  serviceUrl: string;
  secret: string;
  userId: string;
  method: string;
  path: string;
  query?: string;
  body?: string;
}): Promise<Response> {
  const body = input.body ?? "";
  const { signature, context } = signBffContext({
    secret: input.secret,
    userId: input.userId,
    method: input.method,
    path: input.path,
    body,
  });
  const url = new URL(input.path.replace(/^\//, ""), normalizedBase(input.serviceUrl));
  if (input.query) url.search = input.query;
  return fetch(url, {
    method: input.method,
    headers: {
      [BFF_HEADER]: signature,
      [BFF_USER_HEADER]: JSON.stringify(context),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body || undefined,
  });
}

async function probeConversation(input: {
  serviceUrl: string;
  secret: string;
  userId: string;
  characterId: string;
}): Promise<ConversationEvidence> {
  const evidence: ConversationEvidence = {
    ok: false,
    attempted: true,
    createSession: { ok: false, error: "not attempted" },
    sendMessage: { ok: false, error: "not attempted" },
    stream: { ok: false, error: "not attempted" },
    getSession: { ok: false, error: "not attempted" },
    noMemory: { ok: false, error: "not attempted" },
    blockedInput: { ok: false, error: "not attempted" },
  };
  try {
    // 1) create session
    const createRes = await signedFetch({
      ...input, method: "POST", path: "/api/v1/chat/sessions",
      body: JSON.stringify({ characterId: input.characterId }),
    });
    const session = (await createRes.json().catch(() => ({}))) as { id?: string };
    evidence.createSession = { ok: createRes.status === 201 && Boolean(session.id), status: createRes.status };
    if (!session.id) return finalizeConversation(evidence);

    // 2) send message
    const sendRes = await signedFetch({
      ...input, method: "POST", path: `/api/v1/chat/sessions/${session.id}/messages`,
      body: JSON.stringify({ content: "hello from the launch probe" }),
    });
    const sent = (await sendRes.json().catch(() => ({}))) as {
      assistantMessageId?: string;
      streamUrl?: string | null;
      status?: string;
    };
    evidence.sendMessage = {
      ok: sendRes.status === 202 && Boolean(sent.assistantMessageId) && sent.status !== "blocked",
      status: sendRes.status,
    };

    // 3) stream: expect start + delta + done
    if (sent.assistantMessageId) {
      evidence.stream = await probeStream({
        ...input, assistantMessageId: sent.assistantMessageId,
      });
    }

    // 4) GET session: assistant should be present (sent or terminal)
    const getRes = await signedFetch({ ...input, method: "GET", path: `/api/v1/chat/sessions/${session.id}` });
    const got = (await getRes.json().catch(() => ({}))) as { messages?: Array<{ role: string; status?: string }> };
    const assistantSent = (got.messages ?? []).some((m) => m.role === "assistant");
    evidence.getSession = { ok: getRes.status === 200 && assistantSent, status: getRes.status, assistantSent };

    // 5) no-memory smoke: toggle memory off then send — must still 202.
    await signedFetch({
      ...input, method: "POST", path: `/api/v1/chat/sessions/${session.id}/memory`,
      body: JSON.stringify({ memoryEnabled: false }),
    });
    const noMemSend = await signedFetch({
      ...input, method: "POST", path: `/api/v1/chat/sessions/${session.id}/messages`,
      body: JSON.stringify({ content: "incognito turn from probe" }),
    });
    evidence.noMemory = { ok: noMemSend.status === 202, status: noMemSend.status };

    // 6) blocked-input smoke: the mock/safety provider blocks the underage keyword.
    const blockedRes = await signedFetch({
      ...input, method: "POST", path: `/api/v1/chat/sessions/${session.id}/messages`,
      body: JSON.stringify({ content: "this references csam content" }),
    });
    const blocked = (await blockedRes.json().catch(() => ({}))) as { status?: string; streamUrl?: string | null };
    evidence.blockedInput = {
      ok: blockedRes.status === 202 && blocked.status === "blocked" && !blocked.streamUrl,
      status: blockedRes.status,
      status_: blocked.status,
    };

    return finalizeConversation(evidence);
  } catch (error) {
    evidence.error = error instanceof Error ? error.message : String(error);
    return finalizeConversation(evidence);
  }
}

function finalizeConversation(evidence: ConversationEvidence): ConversationEvidence {
  evidence.ok =
    evidence.createSession.ok &&
    evidence.sendMessage.ok &&
    evidence.stream.ok &&
    evidence.getSession.ok &&
    evidence.noMemory.ok &&
    evidence.blockedInput.ok;
  return evidence;
}

async function probeStream(input: {
  serviceUrl: string;
  secret: string;
  userId: string;
  assistantMessageId: string;
}): Promise<ConversationEvidence["stream"]> {
  const path = `/api/v1/chat/messages/${input.assistantMessageId}/stream`;
  try {
    const res = await signedFetch({ ...input, method: "GET", path });
    if (!res.ok || !res.body) return { ok: false, status: res.status, error: `HTTP ${res.status}` };
    const text = await readStreamWithTimeout(res, 8000);
    const sawStart = /event:\s*start|"type"\s*:\s*"start"/.test(text);
    const sawDelta = /event:\s*delta|"type"\s*:\s*"delta"/.test(text);
    const sawDone = /event:\s*done|"type"\s*:\s*"done"/.test(text);
    return { ok: sawStart && sawDelta && sawDone, status: res.status, sawStart, sawDelta, sawDone };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Read an SSE response body until `done` is seen or the timeout elapses. */
async function readStreamWithTimeout(res: Response, timeoutMs: number): Promise<string> {
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      const { done, value } = await Promise.race([
        reader.read(),
        new Promise<{ done: true; value: undefined }>((resolve) =>
          setTimeout(() => resolve({ done: true, value: undefined }), Math.max(0, deadline - Date.now())),
        ),
      ]);
      if (done) break;
      if (value) text += decoder.decode(value, { stream: true });
      if (/event:\s*done|"type"\s*:\s*"done"/.test(text)) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return text;
}

async function probeHealth(serviceUrl: string | null): Promise<ChatServiceProbeReport["health"]> {
  if (!serviceUrl?.trim()) return { ok: false, error: "CHAT_SERVICE_URL is required" };
  try {
    const response = await fetch(new URL("/healthz", normalizedBase(serviceUrl)));
    const json = (await response.json().catch(() => ({}))) as unknown;
    const record = isRecord(json) ? json : {};
    return {
      ok: response.status === 200 && record.ok === true && record.service === "chat",
      status: response.status,
      service: typeof record.service === "string" ? record.service : null,
      error: response.ok ? null : `HTTP ${response.status}`,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function probeSignedSessions(input: {
  serviceUrl: string;
  secret: string;
  userId: string;
}): Promise<ChatServiceProbeReport["signedRequest"]> {
  const method = "GET";
  const requestPath = "/api/v1/chat/sessions";
  const body = "";
  const { signature, context } = signBffContext({
    secret: input.secret,
    userId: input.userId,
    method,
    path: requestPath,
    body,
  });
  const response = await fetch(new URL(requestPath, normalizedBase(input.serviceUrl)), {
    method,
    headers: {
      [BFF_HEADER]: signature,
      [BFF_USER_HEADER]: JSON.stringify(context),
    },
  });
  const json = (await response.json().catch(() => undefined)) as unknown;
  const isSessionList = Array.isArray(json);
  return {
    ok: response.status === 200 && isSessionList,
    status: response.status,
    sessionsCount: isSessionList ? json.length : undefined,
    error: response.status === 200 ? null : `HTTP ${response.status}`,
  };
}

async function probeUnsignedSessions(
  serviceUrl: string,
): Promise<ChatServiceProbeReport["unsignedRequest"]> {
  try {
    const response = await fetch(
      new URL("/api/v1/chat/sessions", normalizedBase(serviceUrl)),
    );
    return {
      ok: response.status === 401,
      status: response.status,
      error: response.status === 401 ? null : `HTTP ${response.status}`,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function normalizedBase(serviceUrl: string) {
  const base = serviceUrl.endsWith("/") ? serviceUrl : `${serviceUrl}/`;
  return new URL(base);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveWorkspacePath(filePath: string) {
  if (path.isAbsolute(filePath)) return filePath;
  return path.resolve(workspaceRoot(), filePath);
}

function workspaceRoot() {
  let current = process.cwd();
  while (true) {
    if (
      existsSync(path.join(current, "package.json")) &&
      (existsSync(path.join(current, "turbo.json")) ||
        existsSync(path.join(current, "bun.lock")))
    ) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) return process.cwd();
    current = parent;
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
