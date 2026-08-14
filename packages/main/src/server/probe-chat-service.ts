import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import "dotenv/config";
import {
  BFF_HEADER,
  BFF_USER_HEADER,
  signBffContext,
} from "@idream/shared/bff";
import { loadCharacterSoulSnapshot } from "@idream/shared";
import { prisma } from "./lib/db";
import { publicCharacterAudienceWhere } from "./modules/ourdream/public-content-audience";
import type { ChatServiceProbeEvidence, ProbeReportOf } from "./readiness/evidence";
import {
  probeCliArg,
  probeReportPath,
  writeProbeReport,
} from "./readiness/probe-report";
import { observeChatSseAcrossReconnects } from "./readiness/chat-sse-probe";

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

// INTENT: 生产端自己的精确形状（ok 必填、永不为 null），比契约里那份"能容忍脏 JSON 的
//         全可选声明"更强；报告组装时由 tsc 校验它能落进契约。
type HealthEvidence = OperationEvidence & { service?: string | null };
type SignedRequestEvidence = OperationEvidence & { sessionsCount?: number };
type RuntimeAuthorityEvidence = OperationEvidence & {
  chatFsRootFingerprint?: string | null;
  sourceRevision?: string | null;
};

type NoMemoryEvidence = OperationEvidence & {
  assistantMessageId?: string;
  authorityPinned?: boolean;
  memorySourceAbsent?: boolean;
  relationshipUnchanged?: boolean;
};

type RegenerateAnchorEvidence = OperationEvidence & {
  assistantMessageId?: string;
  originalAttempt?: number;
  regeneratedAttempt?: number;
  originalSceneVersion?: number | null;
  futureUserSceneVersion?: number | null;
  futureSceneVersion?: number | null;
  regeneratedSceneVersion?: number | null;
};

type CleanupEvidence = OperationEvidence & {
  memoryGone?: boolean;
  memoriesDeleted?: number;
  relationshipDeleted?: boolean;
  relationshipsDeleted?: number;
  relationshipsGone?: boolean;
  sessionDeleted?: boolean;
  sessionGone?: boolean;
};

// End-to-end conversation smoke (design §10.4): create → send → stream → get,
// plus a no-memory smoke and a blocked-input smoke. Each sub-step carries its own
// evidence so a failure is diagnosable from the report alone.
type ConversationEvidence = {
  ok: boolean;
  attempted: boolean;
  preflightCleanup: OperationEvidence;
  createSession: OperationEvidence;
  sendMessage: OperationEvidence;
  stream: OperationEvidence & { sawStart?: boolean; sawDelta?: boolean; sawDone?: boolean };
  getSession: OperationEvidence & {
    assistantMessageId?: string;
    assistantSent?: boolean;
    assistantStatus?: string | null;
    derivationSettled?: boolean;
  };
  regenerateAnchor: RegenerateAnchorEvidence;
  noMemory: NoMemoryEvidence;
  blockedInput: OperationEvidence & { status_?: string };
  cleanup: CleanupEvidence;
  error?: string | null;
};

// SPEC: 写出的 JSON 由 launch gate 的 evidence 契约约束，两端共用 readiness/evidence.ts。
// INTENT: 只把顶层收到契约上 —— 上面那几个嵌套类型（characterSource 的字面量联合、各步骤的
//         OperationEvidence）比契约更精确，赋值时由 tsc 校验它们能落进契约，精度不丢。
type ChatServiceProbeReport = ProbeReportOf<ChatServiceProbeEvidence>;

const CHAT_PROBE_USER_ID = "seed-chat-probe-user";

function readOptions(): ProbeOptions {
  return {
    report: probeReportPath("chatServiceProbe"),
    serviceUrl: probeCliArg("service-url") ?? process.env.CHAT_SERVICE_URL ?? null,
    userId: probeCliArg("user-id") ?? process.env.CHAT_SERVICE_PROBE_USER_ID ?? CHAT_PROBE_USER_ID,
    characterId: probeCliArg("character-id") ?? process.env.CHAT_SERVICE_PROBE_CHARACTER_ID ?? null,
  };
}

async function main() {
  const options = readOptions();
  try {
    const report = await runProbe({
      serviceUrl: options.serviceUrl,
      userId: options.userId,
      characterId: options.characterId,
      secret: process.env.CHAT_BFF_SIGNING_SECRET ?? null,
    });

    if (options.report) {
      await writeProbeReport(options.report, report);
    }

    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.ok) process.exitCode = 1;
  } finally {
    await prisma.$disconnect().catch(() => {});
  }
}

const SKIPPED_OP: OperationEvidence = { ok: false, error: "skipped" };

function skippedConversation(reason: string): ConversationEvidence {
  return {
    ok: true,
    attempted: false,
    preflightCleanup: SKIPPED_OP,
    createSession: SKIPPED_OP,
    sendMessage: SKIPPED_OP,
    stream: SKIPPED_OP,
    getSession: SKIPPED_OP,
    regenerateAnchor: SKIPPED_OP,
    noMemory: SKIPPED_OP,
    blockedInput: SKIPPED_OP,
    cleanup: SKIPPED_OP,
    error: reason,
  };
}

export function assertDedicatedChatProbeActor(
  actor: {
    dataClass: string;
    deletedAt: Date | null;
    id: string;
    role: string;
    status: string;
  } | null,
  expectedUserId: string,
) {
  if (
    !actor ||
    actor.id !== expectedUserId ||
    actor.id !== CHAT_PROBE_USER_ID ||
    actor.dataClass !== "audit" ||
    actor.role !== "user" ||
    actor.status !== "active" ||
    actor.deletedAt !== null
  ) {
    throw new Error(
      `CHAT_SERVICE_PROBE_USER_ID must resolve to the dedicated active audit actor "${CHAT_PROBE_USER_ID}"`,
    );
  }
  return {
    actorDataClass: actor.dataClass,
    dedicatedActor: true,
  } as const;
}

export async function runProbe(input: {
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
    actorDataClass: null as string | null,
    dedicatedActor: false,
    characterId: input.characterId,
    characterSource: (input.characterId?.trim() ? "argument" : "missing") as
      | "argument"
      | "database"
      | "missing",
    usedSignedBff: Boolean(input.secret?.trim()),
  };

  const health = await probeHealth(input.serviceUrl);
  let signedRequest: SignedRequestEvidence = {
    ok: false,
    error: "CHAT_BFF_SIGNING_SECRET is required for chat service probe",
  };
  let unsignedRequest: OperationEvidence = {
    ok: false,
    error: "not attempted",
  };
  let runtimeAuthority: RuntimeAuthorityEvidence = {
    ok: false,
    error: "CHAT_BFF_SIGNING_SECRET is required for runtime authority probe",
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
    const actor = await prisma.user.findUnique({
      where: { id: input.userId },
      select: {
        id: true,
        role: true,
        status: true,
        dataClass: true,
        deletedAt: true,
      },
    });
    const actorAuthority = assertDedicatedChatProbeActor(actor, input.userId);
    baseReport.actorDataClass = actorAuthority.actorDataClass;
    baseReport.dedicatedActor = actorAuthority.dedicatedActor;

    signedRequest = await probeSignedSessions({
      serviceUrl: input.serviceUrl,
      secret: input.secret,
      userId: input.userId,
    });
    runtimeAuthority = await probeSignedRuntimeAuthority({
      serviceUrl: input.serviceUrl,
      secret: input.secret,
      userId: input.userId,
    });
    unsignedRequest = await probeUnsignedSessions(input.serviceUrl);
    const character = await resolveProbeCharacter(input.characterId);
    if (!character.id) {
      conversation = skippedConversation(character.error ?? "no probe character available");
    } else {
      baseReport.characterId = character.id;
      baseReport.characterSource = character.source;
      conversation = await probeConversation({
        serviceUrl: input.serviceUrl,
        secret: input.secret,
        userId: input.userId,
        characterId: character.id,
        runId: randomUUID(),
      });
    }
  } catch (error) {
    return {
      ...baseReport,
      ok: false,
      durationMs: Date.now() - startedAt,
      health,
      signedRequest,
      runtimeAuthority,
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
    runtimeAuthority.ok &&
    unsignedRequest.status === 401 &&
    // A SKIPPED conversation smoke (no eligible character, or main DB unreachable) must NOT
    // report green: launch-readiness fails on conversation.attempted !== true, so the probe's
    // own exit code has to agree or an operator/CI trusting it gets a false PASS.
    conversation.attempted &&
    conversation.ok &&
    baseReport.actorDataClass === "audit" &&
    baseReport.dedicatedActor &&
    Boolean(input.secret?.trim());

  return {
    ...baseReport,
    ok,
    durationMs: Date.now() - startedAt,
    health,
    signedRequest,
    runtimeAuthority,
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

async function resolveProbeCharacter(
  characterId: string | null,
): Promise<{
  id: string | null;
  source: "argument" | "database" | "missing";
  error?: string | null;
}> {
  const explicit = characterId?.trim();
  if (explicit) return { id: explicit, source: "argument" };
  try {
    const characters = await prisma.character.findMany({
      where: {
        AND: [
          publicCharacterAudienceWhere,
          { age: { gte: 18 } },
        ],
      },
      orderBy: [{ source: "asc" }, { createdAt: "desc" }],
      select: {
        id: true,
        currentContentVersionId: true,
        serving: {
          select: {
            currentRelease: {
              select: { characterContentVersionId: true },
            },
          },
        },
      },
    });
    const effectiveContentVersionIds = characters
      .map((character) =>
        character.serving?.currentRelease?.characterContentVersionId ??
        character.currentContentVersionId
      )
      .filter((id): id is string => Boolean(id));
    const contentVersions = effectiveContentVersionIds.length > 0
      ? await prisma.characterContentVersion.findMany({
          where: { id: { in: [...new Set(effectiveContentVersionIds)] } },
          select: { id: true, personaSnapshot: true },
        })
      : [];
    const snapshotByContentVersionId = new Map(
      contentVersions.map((version) => [version.id, version.personaSnapshot]),
    );
    const selectedId = selectSoulReadyProbeCharacter(characters.map((character) => {
      const contentVersionId =
        character.serving?.currentRelease?.characterContentVersionId ??
        character.currentContentVersionId;
      return {
        id: character.id,
        personaSnapshot: contentVersionId
          ? snapshotByContentVersionId.get(contentVersionId) ?? null
          : null,
      };
    }));
    if (selectedId) return { id: selectedId, source: "database" };
    return {
      id: null,
      source: "missing",
      error:
        "CHAT_SERVICE_PROBE_CHARACTER_ID is not set and no public approved adult character has a complete immutable Soul in the main DB",
    };
  } catch (error) {
    return {
      id: null,
      source: "missing",
      error: `Could not auto-resolve probe character: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

export function selectSoulReadyProbeCharacter(
  candidates: ReadonlyArray<{ id: string; personaSnapshot: unknown | null }>,
): string | null {
  for (const candidate of candidates) {
    if (
      candidate.personaSnapshot !== null &&
      loadCharacterSoulSnapshot(candidate.personaSnapshot).ok
    ) {
      return candidate.id;
    }
  }
  return null;
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
  idempotencyKey?: string;
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
      ...(input.method === "POST" &&
      /^\/api\/v1\/chat\/sessions\/[^/]+\/messages\/?$/.test(input.path)
        ? { "idempotency-key": input.idempotencyKey ?? randomUUID() }
        : {}),
    },
    body: body || undefined,
  });
}

async function probeConversation(input: {
  serviceUrl: string;
  secret: string;
  userId: string;
  characterId: string;
  runId: string;
}): Promise<ConversationEvidence> {
  const evidence: ConversationEvidence = {
    ok: false,
    attempted: true,
    preflightCleanup: { ok: false, error: "not attempted" },
    createSession: { ok: false, error: "not attempted" },
    sendMessage: { ok: false, error: "not attempted" },
    stream: { ok: false, error: "not attempted" },
    getSession: { ok: false, error: "not attempted" },
    regenerateAnchor: { ok: false, error: "not attempted" },
    noMemory: { ok: false, error: "not attempted" },
    blockedInput: { ok: false, error: "not attempted" },
    cleanup: { ok: false, error: "not attempted" },
  };
  let sessionId: string | null = null;
  try {
    // A failed prior probe may have left an active audit session. Remove only
    // this dedicated actor's visible state before creating a fresh run.
    evidence.preflightCleanup = await cleanupExistingProbeState(input);
    if (!evidence.preflightCleanup.ok) {
      throw new Error(
        evidence.preflightCleanup.error ?? "probe preflight cleanup failed",
      );
    }

    // 1) create a fresh audit-only session
    const createRes = await signedFetch({
      ...input, method: "POST", path: "/api/v1/chat/sessions",
      body: JSON.stringify({ characterId: input.characterId }),
    });
    const session = (await createRes.json().catch(() => ({}))) as { id?: string };
    evidence.createSession = { ok: createRes.status === 201 && Boolean(session.id), status: createRes.status };
    if (!session.id) throw new Error(`create session returned HTTP ${createRes.status}`);
    sessionId = session.id;

    // 2) send message
    const sendRes = await signedFetch({
      ...input, method: "POST", path: `/api/v1/chat/sessions/${sessionId}/messages`,
      body: JSON.stringify({
        content: "Tonight we're in the rooftop garden with Mina. I feel calm, and we still need to choose the train.",
      }),
      idempotencyKey: `chat-probe:${input.runId}:normal`,
    });
    const sent = (await sendRes.json().catch(() => ({}))) as {
      assistantMessageId?: string;
      userMessageId?: string;
      streamUrl?: string | null;
      status?: string;
    };
    evidence.sendMessage = {
      ok: sendRes.status === 202 && Boolean(sent.assistantMessageId) && sent.status !== "blocked",
      status: sendRes.status,
    };
    if (!sent.assistantMessageId) {
      throw new Error(`normal send returned HTTP ${sendRes.status} without assistantMessageId`);
    }

    // 3) stream: expect start + delta + done
    evidence.stream = await probeStream({
      ...input, assistantMessageId: sent.assistantMessageId,
    });

    // 4) Wait through memory.extract for the normal turn before taking the
    // relationship baseline. SSE done is emitted before that derived job.
    const normal = await waitForSessionMessage({
      ...input,
      sessionId,
      assistantMessageId: sent.assistantMessageId,
      requireMemoryExtracted: true,
    });
    const assistant = normal.message;
    const assistantSent =
      assistant?.role === "assistant" &&
      assistant.status === "sent" &&
      Boolean(assistant.content?.trim());
    evidence.getSession = {
      ok: normal.status === 200 && assistantSent && normal.settled === true,
      status: normal.status,
      assistantMessageId: sent.assistantMessageId,
      assistantSent,
      assistantStatus: assistant?.status ?? null,
      derivationSettled: normal.settled,
    };

    // 5) Create a later Scene revision, then regenerate the first assistant
    // attempt. The regenerated PreparedTurn must retain the original user
    // anchor (Scene v0) rather than reading the later Scene head.
    const futureSend = await signedFetch({
      ...input,
      method: "POST",
      path: `/api/v1/chat/sessions/${sessionId}/messages`,
      body: JSON.stringify({
        content: "Now we move to the train station at dawn, after choosing the train.",
      }),
      idempotencyKey: `chat-probe:${input.runId}:future-scene`,
    });
    const futureTurn = (await futureSend.json().catch(() => ({}))) as {
      assistantMessageId?: string;
      userMessageId?: string;
    };
    const futureStream = futureTurn.assistantMessageId
      ? await probeStream({ ...input, assistantMessageId: futureTurn.assistantMessageId })
      : { ok: false, error: "missing future assistantMessageId" };
    const futureState = futureTurn.assistantMessageId
      ? await waitForSessionMessage({
          ...input,
          sessionId,
          assistantMessageId: futureTurn.assistantMessageId,
          requireMemoryExtracted: true,
        })
      : { status: 0, message: null, settled: false };
    const regenerate = await signedFetch({
      ...input,
      method: "POST",
      path: `/api/v1/chat/messages/${sent.assistantMessageId}/regenerate`,
    });
    const regenerated = (await regenerate.json().catch(() => ({}))) as {
      assistantMessageId?: string;
      attempt?: number;
    };
    const regeneratedStream = regenerated.assistantMessageId
      ? await probeStream({ ...input, assistantMessageId: regenerated.assistantMessageId })
      : { ok: false, error: "missing regenerated assistantMessageId" };
    const regeneratedState = regenerated.assistantMessageId
      ? await waitForSessionMessage({
          ...input,
          sessionId,
          assistantMessageId: regenerated.assistantMessageId,
          requireMemoryExtracted: true,
        })
      : { status: 0, message: null, settled: false };
    const originalSceneVersion = sceneVersion(assistant?.scene);
    const futureUserSceneVersion = futureState.messages?.find(
      (message) => message.id === futureTurn.userMessageId,
    )?.sceneVersion ?? null;
    const futureSceneVersion = sceneVersion(futureState.message?.scene);
    const regeneratedSceneVersion = sceneVersion(regeneratedState.message?.scene);
    evidence.regenerateAnchor = {
      ok:
        futureSend.status === 202 &&
        futureStream.ok &&
        futureState.settled === true &&
        regenerate.status === 202 &&
        regeneratedStream.ok &&
        regeneratedState.settled === true &&
        originalSceneVersion === 0 &&
        futureUserSceneVersion === 1 &&
        futureSceneVersion === 1 &&
        regeneratedSceneVersion === originalSceneVersion &&
        regeneratedState.message?.attempt === regenerated.attempt,
      status: regenerate.status,
      assistantMessageId: regenerated.assistantMessageId,
      originalAttempt: assistant?.attempt,
      regeneratedAttempt: regeneratedState.message?.attempt,
      originalSceneVersion,
      futureUserSceneVersion,
      futureSceneVersion,
      regeneratedSceneVersion,
      error:
        futureStream.ok &&
        regeneratedStream.ok &&
        originalSceneVersion === 0 &&
        futureUserSceneVersion === 1 &&
        futureSceneVersion === 1 &&
        regeneratedSceneVersion === originalSceneVersion
          ? null
          : `futureStream=${futureStream.ok}; futureSettled=${futureState.settled}; regenerateStream=${regeneratedStream.ok}; regenerateSettled=${regeneratedState.settled}; scenes=${originalSceneVersion}/${futureUserSceneVersion}/${futureSceneVersion}/${regeneratedSceneVersion}`,
    };

    const relationshipBefore = await readProbeRelationship(input);

    // 6) no-memory smoke: the assistant row must pin disabled even though the
    // session is later restored, with no relationship or memory derivation.
    const disableMemory = await signedFetch({
      ...input, method: "POST", path: `/api/v1/chat/sessions/${sessionId}/memory`,
      body: JSON.stringify({ memoryEnabled: false }),
    });
    const noMemSend = await signedFetch({
      ...input, method: "POST", path: `/api/v1/chat/sessions/${sessionId}/messages`,
      body: JSON.stringify({
        content: "incognito probe: please call me ProbeSecret and I like probe tea",
      }),
      idempotencyKey: `chat-probe:${input.runId}:no-memory`,
    });
    const noMemTurn = (await noMemSend.json().catch(() => ({}))) as {
      assistantMessageId?: string;
      userMessageId?: string;
    };
    const noMemStream = noMemTurn.assistantMessageId
      ? await probeStream({ ...input, assistantMessageId: noMemTurn.assistantMessageId })
      : { ok: false, error: "missing assistantMessageId" };
    const noMemState = noMemTurn.assistantMessageId
      ? await waitForSessionMessage({
          ...input,
          sessionId,
          assistantMessageId: noMemTurn.assistantMessageId,
          requireMemoryExtracted: false,
        })
      : { status: 0, message: null };
    await delay(
      readPositiveIntEnv("CHAT_SERVICE_PROBE_NO_MEMORY_SETTLE_MS", 1_000),
    );
    const [relationshipAfter, memoriesAfter] = await Promise.all([
      readProbeRelationship(input),
      readProbeMemories(input),
    ]);
    const authorityPinned =
      noMemState.message?.memoryAuthority === "disabled" &&
      noMemState.message.memoryExtractedAttempt === 0;
    const relationshipUnchanged =
      relationshipFingerprint(relationshipAfter) ===
      relationshipFingerprint(relationshipBefore);
    const memorySourceAbsent =
      Boolean(noMemTurn.userMessageId) &&
      !memoriesAfter.some((memory) =>
        memory.sourceMessageIds.includes(noMemTurn.userMessageId!),
      );
    evidence.noMemory = {
      ok:
        disableMemory.status === 200 &&
        noMemSend.status === 202 &&
        noMemStream.ok &&
        authorityPinned &&
        relationshipUnchanged &&
        memorySourceAbsent,
      status: noMemSend.status,
      assistantMessageId: noMemTurn.assistantMessageId,
      authorityPinned,
      relationshipUnchanged,
      memorySourceAbsent,
      error:
        disableMemory.status === 200 &&
        noMemStream.ok &&
        authorityPinned &&
        relationshipUnchanged &&
        memorySourceAbsent
        ? null
        : `disable=${disableMemory.status}; stream=${noMemStream.ok}; authority=${authorityPinned}; relationship=${relationshipUnchanged}; memory=${memorySourceAbsent}`,
    };

    // 7) blocked-input smoke: the mock/safety provider blocks the underage keyword.
    const blockedRes = await signedFetch({
      ...input, method: "POST", path: `/api/v1/chat/sessions/${sessionId}/messages`,
      body: JSON.stringify({ content: "this references csam content" }),
      idempotencyKey: `chat-probe:${input.runId}:blocked`,
    });
    const blocked = (await blockedRes.json().catch(() => ({}))) as { status?: string; streamUrl?: string | null };
    evidence.blockedInput = {
      ok: blockedRes.status === 202 && blocked.status === "blocked" && !blocked.streamUrl,
      status: blockedRes.status,
      status_: blocked.status,
    };
  } catch (error) {
    evidence.error = error instanceof Error ? error.message : String(error);
  } finally {
    evidence.cleanup = await cleanupCompletedProbeState({
      ...input,
      sessionId,
    });
  }
  return finalizeConversation(evidence);
}

type ProbeSessionMessage = {
  attempt?: number;
  content?: string;
  id?: string;
  memoryAuthority?: string;
  memoryExtractedAttempt?: number;
  role?: string;
  status?: string;
  sceneVersion?: number;
  scene?: unknown;
};

async function cleanupExistingProbeState(input: {
  serviceUrl: string;
  secret: string;
  userId: string;
  characterId: string;
}): Promise<OperationEvidence> {
  try {
    const list = await signedFetch({
      ...input,
      method: "GET",
      path: "/api/v1/chat/sessions",
    });
    const sessions = (await list.json().catch(() => [])) as Array<{
      id?: string;
    }>;
    if (list.status !== 200 || !Array.isArray(sessions)) {
      return { ok: false, status: list.status, error: "could not list prior audit sessions" };
    }
    for (const session of sessions) {
      if (!session.id) continue;
      const deleted = await signedFetch({
        ...input,
        method: "DELETE",
        path: `/api/v1/chat/sessions/${session.id}`,
      });
      if (deleted.status !== 200) {
        return {
          ok: false,
          status: deleted.status,
          error: `could not delete prior audit session ${session.id}`,
        };
      }
    }
    const fileAuthority = await clearProbeFileAuthority(input);
    const verify = await signedFetch({
      ...input,
      method: "GET",
      path: "/api/v1/chat/sessions",
    });
    const remaining = (await verify.json().catch(() => [])) as unknown;
    const ok =
      fileAuthority.ok &&
      verify.status === 200 &&
      Array.isArray(remaining) &&
      remaining.length === 0;
    return {
      ok,
      status: verify.status,
      error: ok
        ? null
        : `fileAuthority=${fileAuthority.error ?? fileAuthority.ok}; verify=${verify.status}; remaining=${Array.isArray(remaining) ? remaining.length : "invalid"}`,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function cleanupCompletedProbeState(input: {
  serviceUrl: string;
  secret: string;
  userId: string;
  characterId: string;
  sessionId: string | null;
}): Promise<CleanupEvidence> {
  if (!input.sessionId) {
    return {
      ok: false,
      memoryGone: false,
      relationshipDeleted: false,
      relationshipsGone: false,
      sessionDeleted: false,
      sessionGone: false,
      error: "probe did not create a session to clean up",
    };
  }
  try {
    const restore = await signedFetch({
      ...input,
      method: "POST",
      path: `/api/v1/chat/sessions/${input.sessionId}/memory`,
      body: JSON.stringify({ memoryEnabled: true }),
    });
    const deleted = await signedFetch({
      ...input,
      method: "DELETE",
      path: `/api/v1/chat/sessions/${input.sessionId}`,
    });
    const fileAuthority = await clearProbeFileAuthority(input);
    const verify = await signedFetch({
      ...input,
      method: "GET",
      path: `/api/v1/chat/sessions/${input.sessionId}`,
    });
    const sessionDeleted = deleted.status === 200;
    const relationshipDeleted = fileAuthority.relationshipsGone === true;
    const sessionGone = verify.status === 404;
    const ok =
      restore.status === 200 &&
      sessionDeleted &&
      fileAuthority.ok &&
      relationshipDeleted &&
      sessionGone;
    return {
      ok,
      status: verify.status,
      memoryGone: fileAuthority.memoryGone,
      memoriesDeleted: fileAuthority.memoriesDeleted,
      sessionDeleted,
      relationshipDeleted,
      relationshipsDeleted: fileAuthority.relationshipsDeleted,
      relationshipsGone: fileAuthority.relationshipsGone,
      sessionGone,
      error: ok
        ? null
        : `restore=${restore.status}; delete=${deleted.status}; fileAuthority=${fileAuthority.error ?? fileAuthority.ok}; verify=${verify.status}`,
    };
  } catch (error) {
    return {
      ok: false,
      memoryGone: false,
      relationshipDeleted: false,
      relationshipsGone: false,
      sessionDeleted: false,
      sessionGone: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function clearProbeFileAuthority(input: {
  serviceUrl: string;
  secret: string;
  userId: string;
}): Promise<CleanupEvidence> {
  try {
    const [memoryResponse, relationshipResponse] = await Promise.all([
      signedFetch({
        ...input,
        method: "GET",
        path: "/api/v1/chat/memories",
      }),
      signedFetch({
        ...input,
        method: "GET",
        path: "/api/v1/chat/relationships",
      }),
    ]);
    const memoryBody = (await memoryResponse.json().catch(() => ({}))) as {
      memories?: Array<{ id?: string }>;
    };
    const relationshipBody = (
      await relationshipResponse.json().catch(() => ({}))
    ) as {
      relationships?: Array<{ characterId?: string }>;
    };
    if (
      memoryResponse.status !== 200 ||
      relationshipResponse.status !== 200 ||
      !Array.isArray(memoryBody.memories) ||
      !Array.isArray(relationshipBody.relationships)
    ) {
      return {
        ok: false,
        memoryGone: false,
        relationshipDeleted: false,
        relationshipsGone: false,
        error: `list memories=${memoryResponse.status}; relationships=${relationshipResponse.status}`,
      };
    }

    let memoriesDeleted = 0;
    for (const memory of memoryBody.memories) {
      if (!memory.id) continue;
      const response = await signedFetch({
        ...input,
        method: "DELETE",
        path: `/api/v1/chat/memories/${encodeURIComponent(memory.id)}`,
      });
      if (response.status !== 200) {
        return {
          ok: false,
          memoriesDeleted,
          memoryGone: false,
          relationshipDeleted: false,
          relationshipsGone: false,
          error: `could not delete audit memory ${memory.id}: HTTP ${response.status}`,
        };
      }
      memoriesDeleted += 1;
    }

    let relationshipsDeleted = 0;
    for (const relationship of relationshipBody.relationships) {
      if (!relationship.characterId) continue;
      const response = await signedFetch({
        ...input,
        method: "DELETE",
        path: `/api/v1/chat/relationships/${encodeURIComponent(relationship.characterId)}`,
      });
      if (response.status !== 200) {
        return {
          ok: false,
          memoriesDeleted,
          memoryGone: false,
          relationshipsDeleted,
          relationshipDeleted: false,
          relationshipsGone: false,
          error: `could not delete audit relationship ${relationship.characterId}: HTTP ${response.status}`,
        };
      }
      relationshipsDeleted += 1;
    }

    const [memoryVerify, relationshipVerify] = await Promise.all([
      signedFetch({
        ...input,
        method: "GET",
        path: "/api/v1/chat/memories",
      }),
      signedFetch({
        ...input,
        method: "GET",
        path: "/api/v1/chat/relationships",
      }),
    ]);
    const verifiedMemories = (await memoryVerify.json().catch(() => ({}))) as {
      memories?: unknown[];
    };
    const verifiedRelationships = (
      await relationshipVerify.json().catch(() => ({}))
    ) as {
      relationships?: unknown[];
    };
    const memoryGone =
      memoryVerify.status === 200 &&
      Array.isArray(verifiedMemories.memories) &&
      verifiedMemories.memories.length === 0;
    const relationshipsGone =
      relationshipVerify.status === 200 &&
      Array.isArray(verifiedRelationships.relationships) &&
      verifiedRelationships.relationships.length === 0;
    return {
      ok: memoryGone && relationshipsGone,
      status: memoryVerify.status,
      memoryGone,
      memoriesDeleted,
      relationshipDeleted: relationshipsGone,
      relationshipsDeleted,
      relationshipsGone,
      error:
        memoryGone && relationshipsGone
          ? null
          : `verify memories=${memoryGone}; relationships=${relationshipsGone}`,
    };
  } catch (error) {
    return {
      ok: false,
      memoryGone: false,
      relationshipDeleted: false,
      relationshipsGone: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function waitForSessionMessage(input: {
  serviceUrl: string;
  secret: string;
  userId: string;
  sessionId: string;
  assistantMessageId: string;
  requireMemoryExtracted: boolean;
}): Promise<{
  status: number;
  message: ProbeSessionMessage | null;
  messages?: ProbeSessionMessage[];
  settled?: boolean;
}> {
  const deadline =
    Date.now() +
    readPositiveIntEnv("CHAT_SERVICE_PROBE_SETTLE_TIMEOUT_MS", 90_000);
  let lastStatus = 0;
  let lastMessage: ProbeSessionMessage | null = null;
  while (Date.now() < deadline) {
    const response = await signedFetch({
      ...input,
      method: "GET",
      path: `/api/v1/chat/sessions/${input.sessionId}`,
    });
    lastStatus = response.status;
    const body = (await response.json().catch(() => ({}))) as {
      messages?: ProbeSessionMessage[];
    };
    lastMessage =
      body.messages?.find(
        (message) => message.id === input.assistantMessageId,
      ) ?? null;
    const sent = lastMessage?.status === "sent";
    const memoryComplete =
      !input.requireMemoryExtracted ||
      (
        typeof lastMessage?.attempt === "number" &&
        typeof lastMessage.memoryExtractedAttempt === "number" &&
        lastMessage.memoryExtractedAttempt >= lastMessage.attempt
      );
    if (response.status === 200 && sent && memoryComplete) {
      return {
        status: response.status,
        message: lastMessage,
        messages: body.messages,
        settled: true,
      };
    }
    await delay(100);
  }
  return { status: lastStatus, message: lastMessage, settled: false };
}

async function readProbeRelationship(input: {
  serviceUrl: string;
  secret: string;
  userId: string;
  characterId: string;
}) {
  const response = await signedFetch({
    ...input,
    method: "GET",
    path: `/api/v1/chat/relationships/${input.characterId}`,
  });
  if (response.status !== 200) {
    throw new Error(`relationship read returned HTTP ${response.status}`);
  }
  return (await response.json()) as {
    signals?: { turns?: number };
    stage?: string;
    summary?: string;
    version?: number;
  };
}

async function readProbeMemories(input: {
  serviceUrl: string;
  secret: string;
  userId: string;
  characterId: string;
}) {
  const response = await signedFetch({
    ...input,
    method: "GET",
    path: "/api/v1/chat/memories",
    query: `characterId=${encodeURIComponent(input.characterId)}`,
  });
  if (response.status !== 200) {
    throw new Error(`memory read returned HTTP ${response.status}`);
  }
  const body = (await response.json()) as {
    memories?: Array<{ sourceMessageIds?: string[] }>;
  };
  return (body.memories ?? []).map((memory) => ({
    sourceMessageIds: memory.sourceMessageIds ?? [],
  }));
}

function relationshipFingerprint(value: {
  signals?: { turns?: number };
  stage?: string;
  summary?: string;
  version?: number;
}) {
  return JSON.stringify({
    signals: value.signals ?? null,
    stage: value.stage ?? null,
    summary: value.summary ?? null,
    version: value.version ?? null,
  });
}

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function finalizeConversation(evidence: ConversationEvidence): ConversationEvidence {
  evidence.ok =
    evidence.preflightCleanup.ok &&
    evidence.createSession.ok &&
    evidence.sendMessage.ok &&
    evidence.stream.ok &&
    evidence.getSession.ok &&
    evidence.regenerateAnchor.ok &&
    evidence.noMemory.ok &&
    evidence.blockedInput.ok &&
    evidence.cleanup.ok;
  return evidence;
}

function sceneVersion(value: unknown): number | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const version = (value as Record<string, unknown>).version;
  return typeof version === "number" && Number.isInteger(version) && version >= 0
    ? version
    : null;
}

async function probeStream(input: {
  serviceUrl: string;
  secret: string;
  userId: string;
  assistantMessageId: string;
}): Promise<ConversationEvidence["stream"]> {
  const path = `/api/v1/chat/messages/${input.assistantMessageId}/stream`;
  try {
    const observed = await observeChatSseAcrossReconnects({
      timeoutMs: readPositiveIntEnv(
        "CHAT_SERVICE_PROBE_STREAM_TIMEOUT_MS",
        180_000,
      ),
      open: (lastEventId) =>
        signedFetch({
          ...input,
          method: "GET",
          path,
          ...(lastEventId
            ? { query: `lastEventId=${encodeURIComponent(lastEventId)}` }
            : {}),
        }),
    });
    return {
      ok: observed.ok,
      status: observed.status,
      sawStart: observed.sawStart,
      sawDelta: observed.sawDelta,
      sawDone: observed.sawDone,
      ...(observed.error ? { error: observed.error } : {}),
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

async function probeHealth(serviceUrl: string | null): Promise<HealthEvidence> {
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
}): Promise<SignedRequestEvidence> {
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

async function probeSignedRuntimeAuthority(input: {
  serviceUrl: string;
  secret: string;
  userId: string;
}): Promise<RuntimeAuthorityEvidence> {
  const method = "GET";
  const requestPath = "/api/v1/chat/runtime-authority";
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
  const fingerprint = isRecord(json) &&
      typeof json.chatFsRootFingerprint === "string"
    ? json.chatFsRootFingerprint
    : null;
  const sourceRevision = isRecord(json) && typeof json.sourceRevision === "string"
    ? json.sourceRevision
    : null;
  return {
    ok:
      response.status === 200 &&
      /^[a-f0-9]{64}$/u.test(fingerprint ?? "") &&
      Boolean(sourceRevision?.trim()),
    status: response.status,
    chatFsRootFingerprint: fingerprint,
    sourceRevision,
    error:
      response.status === 200 && fingerprint && sourceRevision
        ? null
        : `HTTP ${response.status}`,
  };
}

async function probeUnsignedSessions(
  serviceUrl: string,
): Promise<OperationEvidence> {
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

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
