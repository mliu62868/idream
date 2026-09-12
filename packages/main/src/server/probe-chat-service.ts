import { createHash, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import "dotenv/config";
import {
  BFF_HEADER,
  BFF_USER_HEADER,
  signBffContext,
} from "@idream/shared/bff";
import { loadCharacterSoulSnapshot } from "@idream/shared";
import { mainWebUrlOrigin } from "@idream/shared/env";
import { createSessionToken, SESSION_COOKIE } from "./lib/auth";
import {
  companionProbeDshEvidenceSchema,
  hasUnexecutedMemorySearchPayload,
  projectCompanionProbeDshEvidence,
  type CompanionProbeDshEvidence,
} from "@idream/shared/chat/companion-runtime";
import { MAIN_TO_CHAT_EVENTS } from "@idream/shared/contracts";
import { prisma } from "./lib/db";
import { companionRelationshipAggregateId } from "./modules/chat/companion-memory-authority";
import { publicCharacterAudienceWhere } from "./modules/ourdream/public-content-audience";
import {
  isStableRegeneratedSceneAnchor,
  type ChatServiceProbeEvidence,
  type ProbeReportOf,
} from "./readiness/evidence";
import {
  probeCliArg,
  probeReportPath,
  writeProbeReport,
} from "./readiness/probe-report";
import { observeChatSseAcrossReconnects } from "./readiness/chat-sse-probe";

type ProbeOptions = {
  report: string | null;
  serviceUrl: string | null;
  mainWebUrl: string;
  internalToken: string | null;
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
type SignedRequestEvidence = OperationEvidence;
type RuntimeAuthorityEvidence = OperationEvidence & {
  chatFsRootFingerprint?: string | null;
  sourceRevision?: string | null;
};

type NoMemoryEvidence = OperationEvidence & {
  assistantMessageId?: string;
  authorityPinned?: boolean;
  dsh?: DshCompanionProbeEvidence;
};

type RegenerateAnchorEvidence = OperationEvidence & {
  assistantMessageId?: string;
  originalAttempt?: number;
  regeneratedAttempt?: number;
  originalSceneVersion?: number | null;
  regeneratedSceneVersion?: number | null;
  recallMatched?: boolean;
  wakeObserved?: boolean;
  memorySearchHit?: boolean;
  regeneratedDsh?: DshCompanionProbeEvidence;
};

export type DshCompanionProbeEvidence = CompanionProbeDshEvidence & { turnId?: string };

type CleanupEvidence = OperationEvidence & {
  memoryCleared?: boolean;
  sessionDeleted?: boolean;
  sessionGone?: boolean;
  sessions?: Array<{
    sessionId: string;
    deleted: boolean;
    gone: boolean;
    deleteStatus: number | null;
    verifyStatus: number | null;
  }>;
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
    dsh?: DshCompanionProbeEvidence;
  };
  recall: OperationEvidence & {
    archiveSession?: OperationEvidence;
    createSession?: OperationEvidence;
    distinctSession?: boolean;
    sourceSessionId?: string;
    sourceTurnId?: string;
    sourceAssistantMessageId?: string;
    sessionId?: string;
    turnId?: string;
    assistantMessageId?: string;
    expectedPhrase?: string;
    actualAnswer?: string | null;
    recallMatched?: boolean;
    wakeObserved?: boolean;
    memorySearchHit?: boolean;
    dsh?: DshCompanionProbeEvidence;
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
type ChatServiceProbeReport = ProbeReportOf<ChatServiceProbeEvidence> & {
  conversation: ConversationEvidence;
};

const CHAT_PROBE_USER_ID = "seed-chat-probe-user";
// INVARIANT: the observer envelope must outlive Chat's default 300s DSH
// attempt budget so it can record the terminal cancel/error instead of racing it.
export const DEFAULT_CHAT_SERVICE_PROBE_STREAM_TIMEOUT_MS = 330_000;

/**
 * INVARIANT: launch evidence may expose attribution and aggregate runtime facts,
 * never the raw trace that also carries prompts, workspace identities and URLs.
 */
export function projectDshCompanionEvidence(
  value: unknown,
  mode: "normal" | "private",
): DshCompanionProbeEvidence {
  return companionProbeDshEvidenceSchema.parse(
    projectCompanionProbeDshEvidence(value, mode),
  );
}

/** Gate E reports only booleans; the unique recall token never leaves this process. */
export function evaluateDshRecallEvidence(input: {
  assistantContent?: string;
  sentinel: string;
  dsh?: DshCompanionProbeEvidence;
}): {
  ok: boolean;
  recallMatched: boolean;
  wakeObserved: boolean;
  memorySearchHit: boolean;
} {
  const recallMatched = Boolean(
    input.assistantContent?.toLowerCase().includes(input.sentinel.toLowerCase()),
  );
  const wakeObserved =
    (input.dsh?.wakeCalls ?? 0) > 0 && input.dsh?.wakeFailures === 0;
  const memorySearchHit =
    (input.dsh?.memorySearchCalls ?? 0) > 0 &&
    (input.dsh?.memorySearchHits ?? 0) > 0 &&
    (input.dsh?.memorySearchEvidenceMatches ?? 0) > 0 &&
    input.dsh?.memorySearchFailures === 0;
  return {
    ok: recallMatched && wakeObserved && memorySearchHit &&
      !hasUnexecutedMemorySearchPayload(input.assistantContent ?? ""),
    recallMatched,
    wakeObserved,
    memorySearchHit,
  };
}

export function describeDshRecallFailure(
  recall: ReturnType<typeof evaluateDshRecallEvidence>,
  dsh?: DshCompanionProbeEvidence,
): string {
  return [
    `accepted=${recall.ok}`,
    `matched=${recall.recallMatched}`,
    `wake=${recall.wakeObserved}`,
    `memorySearch=${recall.memorySearchHit}`,
    `calls=${dsh?.memorySearchCalls ?? 0}`,
    `hits=${dsh?.memorySearchHits ?? 0}`,
    `evidenceMatches=${dsh?.memorySearchEvidenceMatches ?? 0}`,
  ].join(";");
}

const COMPANION_MEMORY_SETTLE_TIMEOUT_MS = 90_000;
const COMPANION_MEMORY_SETTLE_POLL_MS = 500;

interface CompanionAttemptEvidenceInput {
  serviceUrl: string;
  internalToken: string | null;
  userId: string;
  sessionId: string;
  messageId: string;
  attempt: number;
  mode: "normal" | "private";
}

/**
 * SPEC: Main's terminal row is the attempt authority. Memory is an independent
 * outbox projection, so launch evidence waits for that relationship projection
 * without depending on a successful Chat-local trace (which is deleted on ACK).
 */
export async function fetchProbeCompanionAttemptEvidence(
  input: CompanionAttemptEvidenceInput & {
    awaitProjection?: boolean;
    settleTimeoutMs?: number;
    sleep?: (ms: number) => Promise<void>;
  },
): Promise<DshCompanionProbeEvidence> {
  if (input.userId !== CHAT_PROBE_USER_ID || !input.internalToken?.trim()) {
    throw new Error("content-free DSH attempt evidence requires the dedicated audit actor and INTERNAL_TOKEN");
  }
  return waitForCompanionAttemptEvidence(input);
}

/** Local quality samples may use the existing private Character's audit owner. */
export async function fetchAuditCompanionAttemptEvidence(input: CompanionAttemptEvidenceInput): Promise<DshCompanionProbeEvidence> {
  const actor = await prisma.user.findUnique({
    where: { id: input.userId },
    select: { role: true, status: true, dataClass: true, deletedAt: true },
  });
  if (!input.internalToken?.trim() || actor?.role !== "user" || actor.status !== "active" || actor.dataClass !== "audit" || actor.deletedAt !== null) {
    throw new Error("Quality attempt evidence requires an active audit user and INTERNAL_TOKEN");
  }
  return waitForCompanionAttemptEvidence(input);
}

async function waitForCompanionAttemptEvidence(input: CompanionAttemptEvidenceInput & {
  awaitProjection?: boolean;
  settleTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<DshCompanionProbeEvidence> {
  const deadline = Date.now() + (input.settleTimeoutMs ?? COMPANION_MEMORY_SETTLE_TIMEOUT_MS);
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (;;) {
    const evidence = await fetchProbeCompanionAttemptEvidenceOnce(input);
    if (
      input.awaitProjection === false ||
      evidence.memoryOutcome !== "pending" ||
      Date.now() >= deadline
    ) return evidence;
    await sleep(COMPANION_MEMORY_SETTLE_POLL_MS);
  }
}

async function fetchProbeCompanionAttemptEvidenceOnce(
  input: CompanionAttemptEvidenceInput,
): Promise<DshCompanionProbeEvidence> {
  const turn = await prisma.chatTurn.findUnique({
    where: { assistantMessageId: input.messageId },
    select: {
      id: true,
      attempt: true,
      assistantStatus: true,
      terminalEvidence: true,
      session: { select: { sessionId: true, userId: true, characterId: true } },
    },
  });
  if (
    !turn ||
    turn.session.sessionId !== input.sessionId ||
    turn.session.userId !== input.userId ||
    turn.attempt !== input.attempt ||
    turn.assistantStatus !== "sent"
  ) {
    throw new Error("Main terminal attempt evidence does not match the probe identity");
  }
  const pending = input.mode === "normal"
    ? await prisma.mainOutboxEvent.findFirst({
        where: {
          eventType: {
            in: [
              MAIN_TO_CHAT_EVENTS.companionMemoryProjectRequestedV1,
              MAIN_TO_CHAT_EVENTS.companionMemoryRebuildRequestedV1,
              MAIN_TO_CHAT_EVENTS.companionMemoryPurgeRequestedV1,
            ],
          },
          aggregateType: "chat_relationship",
          aggregateId: companionRelationshipAggregateId(
            input.userId,
            turn.session.characterId,
          ),
          status: { in: ["pending", "processing"] },
        },
        select: { id: true },
      })
    : null;
  return {
    ...companionProbeDshEvidenceSchema.parse(projectCompanionProbeDshEvidence(
      turn.terminalEvidence,
      input.mode,
      input.mode === "private" ? "disabled" : pending ? "pending" : "projected",
    )),
    turnId: turn.id,
  };
}

function readOptions(): ProbeOptions {
  return {
    report: probeReportPath("chatServiceProbe"),
    serviceUrl: probeCliArg("service-url") ?? process.env.CHAT_SERVICE_URL ?? null,
    // INVARIANT: resolved exactly the way the running code resolves it. This
    // used to carry an extra `BETTER_AUTH_URL` fallback, so the probe could
    // reach a Main that production configuration could not — a green probe
    // vouching for a deployment that would not start.
    mainWebUrl: mainWebUrlOrigin(
      probeCliArg("main-web-url") ?? process.env.MAIN_WEB_URL,
    ),
    internalToken: process.env.INTERNAL_TOKEN ?? null,
    userId: probeCliArg("user-id") ?? process.env.CHAT_SERVICE_PROBE_USER_ID ?? CHAT_PROBE_USER_ID,
    characterId: probeCliArg("character-id") ?? process.env.CHAT_SERVICE_PROBE_CHARACTER_ID ?? null,
  };
}

async function main() {
  const options = readOptions();
  try {
    const report = await runProbe({
      serviceUrl: options.serviceUrl,
      mainWebUrl: options.mainWebUrl,
      userId: options.userId,
      characterId: options.characterId,
      secret: process.env.CHAT_BFF_SIGNING_SECRET ?? null,
      internalToken: options.internalToken,
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
    recall: SKIPPED_OP,
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
  mainWebUrl?: string;
  userId: string;
  characterId: string | null;
  secret: string | null;
  internalToken?: string | null;
}): Promise<ChatServiceProbeReport> {
  const checkedAt = new Date().toISOString();
  const startedAt = Date.now();
  const mainWebUrl = input.mainWebUrl ?? process.env.MAIN_WEB_URL ??
    process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:3000";
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
  let authToken: string | null = null;

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

    const character = await resolveProbeCharacter(input.characterId);
    // Resolve the destructive scope before even creating a short auth Session.
    // A Quality or unknown-purpose conversation blocks this whole preflight.
    if (character.id) await readProbeCleanupSessions({ userId: input.userId, characterId: character.id });

    authToken = createSessionToken();
    await prisma.session.create({
      data: {
        userId: input.userId,
        token: authToken,
        expiresAt: new Date(Date.now() + 30 * 60_000),
      },
    });
    signedRequest = await probeSignedRuntimeAuthority({
      serviceUrl: input.serviceUrl,
      secret: input.secret,
      userId: input.userId,
    }).then((result) => ({ ok: result.ok, status: result.status, error: result.error }));
    runtimeAuthority = await probeSignedRuntimeAuthority({
      serviceUrl: input.serviceUrl,
      secret: input.secret,
      userId: input.userId,
    });
    unsignedRequest = await probeUnsignedRuntimeAuthority(input.serviceUrl);
    if (!character.id) {
      conversation = skippedConversation(character.error ?? "no probe character available");
    } else {
      baseReport.characterId = character.id;
      baseReport.characterSource = character.source;
      conversation = await probeConversation({
        serviceUrl: input.serviceUrl,
        mainWebUrl,
        authToken,
        secret: input.secret,
        internalToken: input.internalToken ?? null,
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
  } finally {
    if (authToken) {
      await prisma.session.deleteMany({ where: { token: authToken } }).catch(() => undefined);
    }
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

/** Exercise the real Main façade with a short-lived audit-user session. */
export async function productFetch(input: {
  mainWebUrl: string;
  authToken: string;
  userId: string;
  method: string;
  path: string;
  query?: string;
  body?: string;
  idempotencyKey?: string;
  signal?: AbortSignal;
}): Promise<Response> {
  const body = input.body ?? "";
  const url = new URL(input.path.replace(/^\//, ""), normalizedBase(input.mainWebUrl));
  if (input.query) url.search = input.query;
  return fetch(url, {
    method: input.method,
    headers: {
      cookie: `${SESSION_COOKIE}=${encodeURIComponent(input.authToken)}`,
      ...(body ? { "content-type": "application/json" } : {}),
      ...(input.method === "POST" &&
      /^\/api\/v1\/chat\/sessions\/[^/]+\/messages\/?$/.test(input.path)
        ? { "idempotency-key": input.idempotencyKey ?? randomUUID() }
        : {}),
    },
    body: body || undefined,
    signal: input.signal,
  });
}

async function probeConversation(input: {
  serviceUrl: string;
  mainWebUrl: string;
  authToken: string;
  secret: string;
  internalToken: string | null;
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
    recall: { ok: false, error: "not attempted" },
    regenerateAnchor: { ok: false, error: "not attempted" },
    noMemory: { ok: false, error: "not attempted" },
    blockedInput: { ok: false, error: "not attempted" },
    cleanup: { ok: false, error: "not attempted" },
  };
  let sessionId: string | null = null;
  const createdSessionIds: string[] = [];
  try {
    // Only explicitly named Probe sessions on this Character are eligible.
    evidence.preflightCleanup = await cleanupExistingProbeState(input);
    if (!evidence.preflightCleanup.ok) {
      throw new Error(
        evidence.preflightCleanup.error ?? "probe preflight cleanup failed",
      );
    }

    // 1) create a fresh audit-only session
    const createRes = await productFetch({
      ...input, method: "POST", path: "/api/v1/chat/sessions",
      body: JSON.stringify({ characterId: input.characterId, title: `Probe ${input.runId} first` }),
    });
    const session = productSessionRecord(await createRes.json().catch(() => ({}))) as { id?: string };
    evidence.createSession = { ok: createRes.status === 201 && Boolean(session.id), status: createRes.status };
    if (!session.id) throw new Error(`create session returned HTTP ${createRes.status}`);
    sessionId = session.id;
    createdSessionIds.push(sessionId);

    const recallSentinel = `idreamrecall_${createHash("sha256")
      .update(input.runId)
      .digest("hex")
      .slice(0, 32)}`;

    // 2) send message and persist one unique fact for the later recall proof.
    const sendRes = await productFetch({
      ...input, method: "POST", path: `/api/v1/chat/sessions/${sessionId}/messages`,
      body: JSON.stringify({
        content:
          `Tonight we're in the rooftop garden with Mina. The exact rooftop probe code word is ${recallSentinel}. ` +
          "I feel calm, and we still need to choose the train.",
      }),
      idempotencyKey: `chat-probe:${input.runId}:normal`,
    });
    const sent = productTurnRecord(await sendRes.json().catch(() => ({}))) as {
      assistantMessageId?: string;
      attempt?: number;
      userMessageId?: string;
      streamUrl?: string | null;
      status?: string;
    };
    evidence.sendMessage = {
      ok: sendRes.status === 202 && Boolean(sent.assistantMessageId) && sent.status !== "blocked",
      status: sendRes.status,
    };
    if (!evidence.sendMessage.ok || !sent.assistantMessageId) {
      throw new Error(`normal send failed: HTTP ${sendRes.status}`);
    }

    // 3) stream: expect start + delta + done
    evidence.stream = await probeStream({
      ...input,
      assistantMessageId: sent.assistantMessageId,
      expectedAttempt: sent.attempt ?? 1,
    });
    if (!evidence.stream.ok) {
      throw new Error(`normal stream failed: ${evidence.stream.error ?? "terminal event missing"}`);
    }

    // 4) Main's terminal Turn closes the user-visible response. The independent
    // memory projection is checked through its durable outbox below.
    const normal = await waitForSessionMessage({
      ...input,
      sessionId,
      assistantMessageId: sent.assistantMessageId,
    });
    const assistant = normal.message;
    const assistantSent =
      assistant?.role === "assistant" &&
      assistant.status === "sent" &&
      Boolean(assistant.content?.trim());
    const normalDsh = await fetchProbeCompanionAttemptEvidence({
      ...input,
      sessionId,
      messageId: sent.assistantMessageId,
      attempt: sent.attempt ?? 1,
      mode: "normal",
    });
    evidence.getSession = {
      ok:
        normal.status === 200 &&
        assistantSent &&
        normal.settled === true &&
        (normalDsh?.ok ?? true),
      status: normal.status,
      assistantMessageId: sent.assistantMessageId,
      assistantSent,
      assistantStatus: assistant?.status ?? null,
      derivationSettled: normal.settled,
      ...(normalDsh ? { dsh: normalDsh, error: normalDsh.error } : {}),
    };
    if (!evidence.getSession.ok) {
      throw new Error(
        `normal terminal state failed: HTTP ${normal.status}; ` +
        `settled=${normal.settled === true}; dsh=${normalDsh?.ok ?? "not_required"}`,
      );
    }

    // 5) Archive preserves relationship memory while releasing the active key.
    // A distinct session excludes the original Turn from the new replay history.
    const sourceSessionId = sessionId;
    evidence.recall = {
      ok: false,
      sourceSessionId,
      sourceTurnId: normalDsh.turnId,
      sourceAssistantMessageId: sent.assistantMessageId,
      expectedPhrase: recallSentinel,
    };
    const archiveRes = await productFetch({
      ...input, method: "POST", path: `/api/v1/chat/sessions/${sourceSessionId}/archive`,
    });
    const archived = productSessionRecord(await archiveRes.json().catch(() => ({}))) as { status?: string };
    evidence.recall.archiveSession = { ok: archiveRes.status === 200 && archived.status === "archived", status: archiveRes.status };
    if (!evidence.recall.archiveSession.ok) {
      throw new Error(`archive source session failed: HTTP ${archiveRes.status}`);
    }
    const recallCreateRes = await productFetch({
      ...input, method: "POST", path: "/api/v1/chat/sessions",
      body: JSON.stringify({ characterId: input.characterId, title: `Probe ${input.runId} recall` }),
    });
    const recallSession = productSessionRecord(await recallCreateRes.json().catch(() => ({}))) as { id?: string };
    if (recallSession.id) createdSessionIds.push(recallSession.id);
    evidence.recall.createSession = { ok: recallCreateRes.status === 201 && Boolean(recallSession.id), status: recallCreateRes.status };
    evidence.recall.sessionId = recallSession.id;
    evidence.recall.distinctSession = Boolean(recallSession.id && recallSession.id !== sourceSessionId);
    if (!evidence.recall.createSession.ok || !recallSession.id) {
      throw new Error(`create recall session failed: HTTP ${recallCreateRes.status}`);
    }
    if (!evidence.recall.distinctSession) throw new Error("recall requires a distinct session");
    const recallSessionId = recallSession.id;
    sessionId = recallSessionId;
    const recallSend = await productFetch({
      ...input,
      method: "POST",
      path: `/api/v1/chat/sessions/${recallSessionId}/messages`,
      body: JSON.stringify({
        content:
          "From our earlier chat, what was the exact rooftop code word we chose? Please say the code word exactly.",
      }),
      idempotencyKey: `chat-probe:${input.runId}:cross-session-recall`,
    });
    const recallTurn = productTurnRecord(await recallSend.json().catch(() => ({}))) as {
      assistantMessageId?: string;
      attempt?: number;
    };
    evidence.recall.assistantMessageId = recallTurn.assistantMessageId;
    const recallStream = recallTurn.assistantMessageId
      ? await probeStream({
          ...input,
          assistantMessageId: recallTurn.assistantMessageId,
          expectedAttempt: recallTurn.attempt ?? 1,
        })
      : { ok: false, error: "missing recall assistantMessageId" };
    if (recallSend.status !== 202 || !recallTurn.assistantMessageId || !recallStream.ok) {
      throw new Error(
        recallSend.status !== 202
          ? `recall send failed: HTTP ${recallSend.status}`
          : `recall stream failed: ${recallStream.error ?? "terminal event missing"}`,
      );
    }
    const recallState = await waitForSessionMessage({
      ...input,
      sessionId: recallSessionId,
      assistantMessageId: recallTurn.assistantMessageId,
    });
    evidence.recall.actualAnswer = recallState.message?.content ?? null;
    const recallDsh = await fetchProbeCompanionAttemptEvidence({
      ...input,
      sessionId: recallSessionId,
      messageId: recallTurn.assistantMessageId,
      attempt: recallTurn.attempt ?? 1,
      mode: "normal",
      awaitProjection: false,
    });
    const recall = evaluateDshRecallEvidence({
      assistantContent: recallState.message?.content,
      sentinel: recallSentinel,
      dsh: recallDsh,
    });
    // SPEC: runProbe admits only the dedicated audit actor. Keep its synthetic
    // source and answer before cleanup so a strict recall failure is diagnosable.
    evidence.recall = {
      ...evidence.recall,
      ...recall,
      ok: recallState.status === 200 && recallState.settled === true && recall.ok && (recallDsh?.ok ?? true),
      status: recallState.status,
      sourceSessionId,
      sourceTurnId: normalDsh.turnId,
      sourceAssistantMessageId: sent.assistantMessageId,
      sessionId: recallSessionId,
      turnId: recallDsh.turnId,
      assistantMessageId: recallTurn.assistantMessageId,
      expectedPhrase: recallSentinel,
      actualAnswer: recallState.message?.content ?? null,
      dsh: recallDsh,
    };
    if (!evidence.recall.ok) {
      throw new Error(
        `relationship recall failed: HTTP ${recallState.status}; settled=${recallState.settled === true}; ` +
        `dsh=${recallDsh?.ok ?? "not_required"}; ${describeDshRecallFailure(recall, recallDsh)}`,
      );
    }

    // 6) Regenerate the latest turn. Main intentionally forbids editing an old
    // turn, so the proof is that the new attempt keeps this turn's immutable
    // Scene anchor while incrementing only the attempt.
    const originalAttempt = recallState.message?.attempt ?? recallTurn.attempt ?? 1;
    const originalSceneVersion = sceneVersion(recallState.message?.scene);
    const regenerate = await productFetch({
      ...input,
      method: "POST",
      path: `/api/v1/chat/messages/${recallTurn.assistantMessageId}/regenerate`,
    });
    const regenerated = (await regenerate.json().catch(() => ({}))) as {
      assistantMessageId?: string;
      attempt?: number;
    };
    if (
      regenerate.status !== 202 ||
      !regenerated.assistantMessageId ||
      !Number.isInteger(regenerated.attempt)
    ) {
      const failure = `regenerate send failed: HTTP ${regenerate.status}`;
      evidence.regenerateAnchor = {
        ok: false,
        status: regenerate.status,
        originalAttempt,
        originalSceneVersion,
        error: failure,
      };
      throw new Error(failure);
    }
    const regeneratedStream = await probeStream({
      ...input,
      assistantMessageId: regenerated.assistantMessageId,
      expectedAttempt: regenerated.attempt!,
    });
    if (!regeneratedStream.ok) {
      const failure =
        `regenerate stream failed: ${regeneratedStream.error ?? "terminal event missing"}`;
      evidence.regenerateAnchor = {
        ok: false,
        status: regenerate.status,
        assistantMessageId: regenerated.assistantMessageId,
        originalAttempt,
        regeneratedAttempt: regenerated.attempt,
        originalSceneVersion,
        error: failure,
      };
      throw new Error(failure);
    }
    const regeneratedState = regenerated.assistantMessageId
      ? await waitForSessionMessage({
          ...input,
          sessionId: recallSessionId,
          assistantMessageId: regenerated.assistantMessageId,
        })
      : { status: 0, message: null, settled: false };
    const regeneratedSceneVersion = sceneVersion(regeneratedState.message?.scene);
    const regeneratedDsh = await fetchProbeCompanionAttemptEvidence({
      ...input,
      sessionId: recallSessionId,
      messageId: regenerated.assistantMessageId!,
      attempt: regenerated.attempt ?? regeneratedState.message?.attempt ?? 1,
      mode: "private",
      awaitProjection: false,
    });
    evidence.regenerateAnchor = {
      ok:
        regenerate.status === 202 &&
        regeneratedStream.ok &&
        regeneratedState.settled === true &&
        recall.ok &&
        isStableRegeneratedSceneAnchor({
          originalAttempt,
          regeneratedAttempt: regeneratedState.message?.attempt,
          originalSceneVersion,
          regeneratedSceneVersion,
        }) &&
        regeneratedState.message?.attempt === regenerated.attempt &&
        (regeneratedDsh?.ok ?? true),
      status: regenerate.status,
      assistantMessageId: regenerated.assistantMessageId,
      originalAttempt,
      regeneratedAttempt: regeneratedState.message?.attempt,
      originalSceneVersion,
      regeneratedSceneVersion,
      recallMatched: recall.recallMatched,
      wakeObserved: recall.wakeObserved,
      memorySearchHit: recall.memorySearchHit,
      ...(regeneratedDsh ? { regeneratedDsh } : {}),
      error:
        regeneratedStream.ok &&
        recall.ok &&
        isStableRegeneratedSceneAnchor({
          originalAttempt,
          regeneratedAttempt: regeneratedState.message?.attempt,
          originalSceneVersion,
          regeneratedSceneVersion,
        }) &&
        (regeneratedDsh?.ok ?? true)
          ? null
          : `regenerateStream=${regeneratedStream.ok}; regenerateSettled=${regeneratedState.settled}; attempts=${originalAttempt}/${regeneratedState.message?.attempt ?? "missing"}; scenes=${originalSceneVersion}/${regeneratedSceneVersion}; recall=${recall.ok}; regeneratedDsh=${regeneratedDsh?.ok ?? "not_required"}`,
    };
    if (!evidence.regenerateAnchor.ok) {
      throw new Error(evidence.regenerateAnchor.error ?? "regenerate evidence failed");
    }

    // 7) no-memory smoke: the assistant row must pin disabled even though the
    // session is later restored, with no Scene or memory derivation.
    const disableMemory = await productFetch({
      ...input, method: "POST", path: `/api/v1/chat/sessions/${sessionId}/memory`,
      body: JSON.stringify({ memoryEnabled: false }),
    });
    if (disableMemory.status !== 200) {
      evidence.noMemory = {
        ok: false,
        status: disableMemory.status,
        error: `disable memory failed: HTTP ${disableMemory.status}`,
      };
      throw new Error(evidence.noMemory.error!);
    }
    const noMemSend = await productFetch({
      ...input, method: "POST", path: `/api/v1/chat/sessions/${sessionId}/messages`,
      body: JSON.stringify({
        content: "incognito probe: please call me ProbeSecret and I like probe tea",
      }),
      idempotencyKey: `chat-probe:${input.runId}:no-memory`,
    });
    const noMemTurn = productTurnRecord(await noMemSend.json().catch(() => ({}))) as {
      assistantMessageId?: string;
      attempt?: number;
      userMessageId?: string;
    };
    if (noMemSend.status !== 202 || !noMemTurn.assistantMessageId) {
      evidence.noMemory = {
        ok: false,
        status: noMemSend.status,
        error: `private send failed: HTTP ${noMemSend.status}`,
      };
      throw new Error(evidence.noMemory.error!);
    }
    const noMemStream = noMemTurn.assistantMessageId
      ? await probeStream({
          ...input,
          assistantMessageId: noMemTurn.assistantMessageId,
          expectedAttempt: noMemTurn.attempt ?? 1,
        })
      : { ok: false, error: "missing assistantMessageId" };
    if (!noMemStream.ok) {
      evidence.noMemory = {
        ok: false,
        status: noMemSend.status,
        assistantMessageId: noMemTurn.assistantMessageId,
        error: `private stream failed: ${noMemStream.error ?? "terminal event missing"}`,
      };
      throw new Error(evidence.noMemory.error!);
    }
    if (noMemTurn.assistantMessageId) {
      await waitForSessionMessage({
        ...input,
        sessionId,
        assistantMessageId: noMemTurn.assistantMessageId,
      });
    }
    const privateDsh = await fetchProbeCompanionAttemptEvidence({
      ...input,
      sessionId,
      messageId: noMemTurn.assistantMessageId,
      attempt: noMemTurn.attempt ?? 1,
      mode: "private",
    });
    const authorityPinned = privateDsh?.memoryMode === "private" &&
      privateDsh.memoryOutcome === "disabled";
    evidence.noMemory = {
      ok:
        disableMemory.status === 200 &&
        noMemSend.status === 202 &&
        noMemStream.ok &&
        authorityPinned &&
        (privateDsh?.ok ?? true),
      status: noMemSend.status,
      assistantMessageId: noMemTurn.assistantMessageId,
      authorityPinned,
      ...(privateDsh ? { dsh: privateDsh } : {}),
      error:
        disableMemory.status === 200 &&
        noMemStream.ok &&
        authorityPinned &&
        (privateDsh?.ok ?? true)
        ? null
        : `disable=${disableMemory.status}; stream=${noMemStream.ok}; authority=${authorityPinned}; privateDsh=${privateDsh?.ok ?? "not_required"}`,
    };
    if (!evidence.noMemory.ok) {
      throw new Error(evidence.noMemory.error ?? "private no-memory evidence failed");
    }

    // 8) blocked-input smoke: the mock/safety provider blocks the underage keyword.
    const blockedRes = await productFetch({
      ...input, method: "POST", path: `/api/v1/chat/sessions/${sessionId}/messages`,
      body: JSON.stringify({ content: "this references csam content" }),
      idempotencyKey: `chat-probe:${input.runId}:blocked`,
    });
    const blocked = productTurnRecord(await blockedRes.json().catch(() => ({}))) as {
      status?: string;
      streamUrl?: string | null;
    };
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
      sessionIds: createdSessionIds,
    });
  }
  return finalizeConversation(evidence);
}

type ProbeSessionMessage = {
  attempt?: number;
  content?: string;
  id?: string;
  role?: string;
  status?: string;
  sceneVersion?: number;
  scene?: unknown;
};

async function readProbeCleanupSessions(input: { userId: string; characterId: string }) {
  const actor = await prisma.user.findUnique({
    where: { id: input.userId },
    select: { id: true, role: true, status: true, dataClass: true, deletedAt: true },
  });
  assertDedicatedChatProbeActor(actor, input.userId);
  const sessions = await prisma.recentChat.findMany({
    where: { userId: input.userId, characterId: input.characterId },
    select: { sessionId: true, userId: true, characterId: true, title: true },
    orderBy: { createdAt: "asc" },
  });
  // Older probes had default titles, indistinguishable from other audit work.
  // Clean those only through cleanupCompletedProbeState with known report IDs.
  const restricted = sessions.filter((session) =>
    session.userId !== input.userId || session.characterId !== input.characterId ||
    !/^Probe [a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12} (first|recall)$/iu.test(session.title ?? "")
  );
  if (restricted.length) {
    throw new Error(`Probe preflight refuses Quality or unknown-purpose sessions on ${input.characterId}: ${restricted.map((session) => session.sessionId).join(", ")}; preserve them or use their original report's exact cleanup IDs`);
  }
  return sessions;
}

export async function cleanupExistingProbeState(input: {
  serviceUrl: string;
  mainWebUrl: string;
  authToken: string;
  secret: string;
  userId: string;
  characterId: string;
}): Promise<OperationEvidence> {
  try {
    // Main PG is the ownership/Character authority, including archived rows.
    // Inspect every target row before the first mutation; never infer scope
    // from the account-wide public session listing or its display fields.
    const sessions = await readProbeCleanupSessions(input);
    let lastDeletedSessionId: string | null = null;
    for (const session of sessions) {
      if (!await waitForProbeMemoryMaintenance(input)) {
        return { ok: false, error: `companion memory did not settle before deleting session ${session.sessionId}` };
      }
      const current = await readProbeCleanupSessions(input);
      if (!current.some((entry) => entry.sessionId === session.sessionId)) continue;
      const deleted = await productFetch({
        ...input,
        method: "DELETE",
        path: `/api/v1/chat/sessions/${session.sessionId}`,
      });
      if (deleted.status !== 200) {
        return {
          ok: false,
          status: deleted.status,
          error: `could not delete prior audit session ${session.sessionId}`,
        };
      }
      lastDeletedSessionId = session.sessionId;
    }
    if (!await waitForProbeMemoryMaintenance(input)) {
      return { ok: false, error: `companion memory did not settle after deleting session ${lastDeletedSessionId ?? "none"}` };
    }
    const remaining = await readProbeCleanupSessions(input);
    if (remaining.length) return { ok: false, error: `Target Probe sessions remain; memory was not cleared: ${remaining.map((session) => session.sessionId).join(", ")}` };
    const fileAuthority = await clearProbeFileAuthority(input);
    const verified = await readProbeCleanupSessions(input);
    const ok = fileAuthority.ok && verified.length === 0;
    return {
      ok,
      status: fileAuthority.status,
      error: ok
        ? null
        : `fileAuthority=${fileAuthority.error ?? fileAuthority.ok}; targetRemaining=${verified.length}`,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function cleanupCompletedProbeState(input: {
  serviceUrl: string;
  mainWebUrl: string;
  authToken: string;
  secret: string;
  userId: string;
  characterId: string;
  sessionId: string | null;
  sessionIds?: readonly string[];
}): Promise<CleanupEvidence> {
  if (!input.sessionId) {
    return {
      ok: false,
      memoryCleared: false,
      sessionDeleted: false,
      sessionGone: false,
      error: "probe did not create a session to clean up",
    };
  }
  try {
    const restore = await productFetch({
      ...input,
      method: "POST",
      path: `/api/v1/chat/sessions/${input.sessionId}/memory`,
      body: JSON.stringify({ memoryEnabled: true }),
    });
    // Clear first: it terminalizes any failed/stranded attempt and waits for
    // the exact destructive mutation. Session deletion can then be final
    // instead of racing an AgentRun and leaving an archived probe row behind.
    const fileAuthority = await clearProbeFileAuthority(input);
    const sessionIds = [...new Set([...(input.sessionIds ?? []), input.sessionId])];
    const deleted: Array<Response | null> = [];
    let memorySettled = true;
    let memoryStage: string | null = null;
    for (const targetSessionId of sessionIds) {
      // Each deletion schedules a relationship-wide rebuild. Its durable idle
      // authority must settle before the next session can be deleted once.
      if (!await waitForProbeMemoryMaintenance(input)) {
        memorySettled = false;
        memoryStage = `before_delete:${targetSessionId}`;
        break;
      }
      deleted.push(await productFetch({
        ...input,
        method: "DELETE",
        path: `/api/v1/chat/sessions/${targetSessionId}`,
      }).catch(() => null));
    }
    if (memorySettled && !await waitForProbeMemoryMaintenance(input)) {
      memorySettled = false;
      memoryStage = `after_delete:${sessionIds.at(-1)}`;
    }
    const verify: Array<Response | null> = [];
    for (const targetSessionId of sessionIds) {
      verify.push(await productFetch({
        ...input,
        method: "GET",
        path: `/api/v1/chat/sessions/${targetSessionId}`,
      }).catch(() => null));
    }
    const sessionDeleted = deleted.length === sessionIds.length && deleted.every((response) =>
      response?.status === 200 || response?.status === 404
    );
    const memoryCleared = fileAuthority.memoryCleared === true && memorySettled;
    const sessionGone = verify.every((response) => response?.status === 404);
    const ok =
      restore.status === 200 &&
      sessionDeleted &&
      fileAuthority.ok &&
      memoryCleared &&
      sessionGone;
    return {
      ok,
      status: verify[0]?.status,
      sessionDeleted,
      memoryCleared,
      sessionGone,
      sessions: sessionIds.map((targetSessionId, index) => ({
        sessionId: targetSessionId,
        deleted: deleted[index]?.status === 200 || deleted[index]?.status === 404,
        gone: verify[index]?.status === 404,
        deleteStatus: deleted[index]?.status ?? null,
        verifyStatus: verify[index]?.status ?? null,
      })),
      error: ok
        ? null
        : `restore=${restore.status}; delete=${deleted.map((response) => response?.status ?? "network_error").join(",")}; fileAuthority=${fileAuthority.error ?? fileAuthority.ok}; memorySettled=${memorySettled}; memoryStage=${memoryStage}; verify=${verify.map((response) => response?.status ?? "network_error").join(",")}`,
    };
  } catch (error) {
    return {
      ok: false,
      memoryCleared: false,
      sessionDeleted: false,
      sessionGone: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function clearProbeFileAuthority(input: {
  serviceUrl: string;
  mainWebUrl: string;
  authToken: string;
  secret: string;
  userId: string;
  characterId: string;
}): Promise<CleanupEvidence> {
  try {
    const response = await productFetch({
      ...input,
      method: "DELETE",
      path: `/api/v1/chat/memory/${encodeURIComponent(input.characterId)}`,
    });
    const accepted = response.status === 200 || response.status === 404;
    const cleared = accepted && await waitForProbeMemoryMaintenance(input);
    return {
      ok: cleared,
      status: response.status,
      memoryCleared: cleared,
      error: cleared
        ? null
        : accepted
        ? "companion memory mutation did not settle before the probe deadline"
        : `clear memory=${response.status}`,
    };
  } catch (error) {
    return {
      ok: false,
      memoryCleared: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function waitForProbeMemoryMaintenance(input: {
  userId: string;
  characterId: string;
}): Promise<boolean> {
  const deadline = Date.now() + chatServiceProbeSettleTimeoutMs();
  const aggregateId = companionRelationshipAggregateId(input.userId, input.characterId);
  // Always observe once, including when a short probe budget crosses a clock
  // tick before the first read. An already-idle projection is still evidence.
  for (;;) {
    const pending = await prisma.mainOutboxEvent.findFirst({
      where: {
        eventType: {
          in: [
            MAIN_TO_CHAT_EVENTS.companionMemoryRebuildRequestedV1,
            MAIN_TO_CHAT_EVENTS.companionMemoryPurgeRequestedV1,
          ],
        },
        aggregateType: "chat_relationship",
        aggregateId,
        status: { in: ["pending", "processing"] },
      },
      select: { id: true },
    });
    if (!pending) return true;
    if (Date.now() >= deadline) return false;
    await delay(100);
  }
}

async function waitForSessionMessage(input: {
  serviceUrl: string;
  mainWebUrl: string;
  authToken: string;
  secret: string;
  userId: string;
  sessionId: string;
  assistantMessageId: string;
}): Promise<{
  status: number;
  message: ProbeSessionMessage | null;
  messages?: ProbeSessionMessage[];
  settled?: boolean;
}> {
  const deadline = Date.now() + chatServiceProbeSettleTimeoutMs();
  let lastStatus = 0;
  let lastMessage: ProbeSessionMessage | null = null;
  let lastMessages: ProbeSessionMessage[] | undefined;
  while (Date.now() < deadline) {
    const response = await productFetch({
      ...input,
      method: "GET",
      path: `/api/v1/chat/sessions/${input.sessionId}`,
    });
    lastStatus = response.status;
    const body = productSessionRecord(await response.json().catch(() => ({}))) as {
      messages?: ProbeSessionMessage[];
    };
    lastMessages = body.messages;
    lastMessage =
      body.messages?.find(
        (message) => message.id === input.assistantMessageId,
      ) ?? null;
    const sent = lastMessage?.status === "sent";
    if (response.status === 200 && sent) {
      return {
        status: response.status,
        message: lastMessage,
        messages: body.messages,
        settled: true,
      };
    }
    await delay(100);
  }
  return {
    status: lastStatus,
    message: lastMessage,
    ...(lastMessages ? { messages: lastMessages } : {}),
    settled: false,
  };
}

export function chatServiceProbeSettleTimeoutMs(): number {
  return readPositiveIntEnv("CHAT_SERVICE_PROBE_SETTLE_TIMEOUT_MS", 90_000);
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
    evidence.recall.ok &&
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

export async function probeStream(input: {
  serviceUrl: string;
  mainWebUrl: string;
  authToken: string;
  secret: string;
  userId: string;
  assistantMessageId: string;
  expectedAttempt: number;
}): Promise<ConversationEvidence["stream"]> {
  const path = `/api/v1/chat/messages/${input.assistantMessageId}/stream`;
  try {
    const observed = await observeChatSseAcrossReconnects({
      expectedAttempt: input.expectedAttempt,
      timeoutMs: readPositiveIntEnv(
        "CHAT_SERVICE_PROBE_STREAM_TIMEOUT_MS",
        DEFAULT_CHAT_SERVICE_PROBE_STREAM_TIMEOUT_MS,
      ),
      open: (lastEventId) =>
        productFetch({
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

async function probeUnsignedRuntimeAuthority(
  serviceUrl: string,
): Promise<OperationEvidence> {
  try {
    const response = await fetch(
      new URL("/api/v1/chat/runtime-authority", normalizedBase(serviceUrl)),
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

function productRecord(value: unknown): Record<string, unknown> {
  const root = isRecord(value) ? value : {};
  return isRecord(root.data) ? root.data : root;
}

function productTurnRecord(value: unknown): Record<string, unknown> {
  const data = productRecord(value);
  const assistant = isRecord(data.assistant) ? data.assistant : {};
  return {
    ...data,
    ...(typeof data.assistantMessageId === "string"
      ? {}
      : typeof assistant.id === "string" ? { assistantMessageId: assistant.id } : {}),
    ...(typeof data.attempt === "number"
      ? {}
      : typeof assistant.attempt === "number" ? { attempt: assistant.attempt } : {}),
    ...(typeof data.status === "string"
      ? {}
      : typeof assistant.status === "string" ? { status: assistant.status } : {}),
  };
}

function productSessionRecord(value: unknown): Record<string, unknown> {
  const data = productRecord(value);
  return isRecord(data.session) ? data.session : data;
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
