import { createHash, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import "dotenv/config";
import {
  BFF_HEADER,
  BFF_USER_HEADER,
  signBffContext,
} from "@idream/shared/bff";
import { loadCharacterSoulSnapshot } from "@idream/shared";
import {
  companionProbeDshEvidenceSchema,
  projectCompanionProbeDshEvidence,
  type CompanionProbeDshEvidence,
} from "@idream/shared/chat/companion-runtime";
import { prisma } from "./lib/db";
import { publicCharacterAudienceWhere } from "./modules/ourdream/public-content-audience";
import {
  isRelativeFutureSceneAnchor,
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
  internalToken: string | null;
  userId: string;
  characterId: string | null;
  expectedCompanionRuntime: "dsh" | null;
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
  relationshipUnchanged?: boolean;
  dsh?: DshCompanionProbeEvidence;
};

type RegenerateAnchorEvidence = OperationEvidence & {
  assistantMessageId?: string;
  originalAttempt?: number;
  regeneratedAttempt?: number;
  originalSceneVersion?: number | null;
  futureUserSceneVersion?: number | null;
  futureSceneVersion?: number | null;
  regeneratedSceneVersion?: number | null;
  recallMatched?: boolean;
  wakeObserved?: boolean;
  memorySearchHit?: boolean;
  futureDsh?: DshCompanionProbeEvidence;
  regeneratedDsh?: DshCompanionProbeEvidence;
};

export type DshCompanionProbeEvidence = CompanionProbeDshEvidence;

type CleanupEvidence = OperationEvidence & {
  relationshipDeleted?: boolean;
  relationshipsDeleted?: number;
  relationshipsGone?: boolean;
  sessionDeleted?: boolean;
  sessionGone?: boolean;
};

type ProbeRolloutAggregate = {
  schemaVersion: 1;
  generatedAt?: string;
  window: { from: string; to: string; durationMs?: number };
  comparisonStatus?: string;
  sampleEvidence?: unknown;
  releaseDecision: { status: "not_evaluated"; reason?: string };
  runtimes: {
    native: { attempts: number };
    dsh: { attempts: number };
  };
  dataScope: {
    userAuthority: "core.chat_user_view";
    scope: "internal-audit";
    includedDataClass: "audit";
    activeCustomersOnly: false;
    exactAuditActorOnly: true;
    userFilterApplied: true;
    windowBasis: "message_versions.created_at";
  };
};

type ProbeRolloutEvidence = OperationEvidence & {
  collectedAt?: string;
  aggregate?: ProbeRolloutAggregate;
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
  regenerateAnchor: RegenerateAnchorEvidence;
  noMemory: NoMemoryEvidence;
  blockedInput: OperationEvidence & { status_?: string };
  rolloutEvidence: ProbeRolloutEvidence;
  cleanup: CleanupEvidence;
  error?: string | null;
};

// SPEC: 写出的 JSON 由 launch gate 的 evidence 契约约束，两端共用 readiness/evidence.ts。
// INTENT: 只把顶层收到契约上 —— 上面那几个嵌套类型（characterSource 的字面量联合、各步骤的
//         OperationEvidence）比契约更精确，赋值时由 tsc 校验它们能落进契约，精度不丢。
type ChatServiceProbeReport = ProbeReportOf<ChatServiceProbeEvidence>;

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
    ok: recallMatched && wakeObserved && memorySearchHit,
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
  fetchImpl?: (
    input: URL | RequestInfo,
    init?: RequestInit,
  ) => Promise<Response>;
}

/**
 * SPEC: SSE `done` closes the user-visible turn at Chat's terminal CAS; the
 * sidecar's memory settlement (ingest + profile maintenance) lands on the
 * attempt trace afterwards. Evidence is therefore polled until the memory
 * outcome leaves `pending`, the same way Scene derivation is awaited above.
 */
export async function fetchProbeCompanionAttemptEvidence(
  input: CompanionAttemptEvidenceInput & {
    settleTimeoutMs?: number;
    sleep?: (ms: number) => Promise<void>;
  },
): Promise<DshCompanionProbeEvidence> {
  const deadline = Date.now() + (input.settleTimeoutMs ?? COMPANION_MEMORY_SETTLE_TIMEOUT_MS);
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (;;) {
    const evidence = await fetchProbeCompanionAttemptEvidenceOnce(input);
    if (evidence.memoryOutcome !== "pending" || Date.now() >= deadline) return evidence;
    await sleep(COMPANION_MEMORY_SETTLE_POLL_MS);
  }
}

async function fetchProbeCompanionAttemptEvidenceOnce(
  input: CompanionAttemptEvidenceInput,
): Promise<DshCompanionProbeEvidence> {
  if (input.userId !== CHAT_PROBE_USER_ID || !input.internalToken?.trim()) {
    throw new Error("content-free DSH attempt evidence requires the dedicated audit actor and INTERNAL_TOKEN");
  }
  const url = new URL(
    "/internal/admin/companion-attempt-evidence",
    normalizedBase(input.serviceUrl),
  );
  url.searchParams.set("userId", input.userId);
  url.searchParams.set("sessionId", input.sessionId);
  url.searchParams.set("messageId", input.messageId);
  url.searchParams.set("mode", input.mode);
  const response = await (input.fetchImpl ?? fetch)(url, {
    method: "GET",
    headers: { "x-internal-token": input.internalToken },
  });
  const body = await response.json().catch(() => null);
  const record = isRecord(body) ? body : {};
  if (
    !response.ok ||
    record.messageId !== input.messageId ||
    record.attempt !== input.attempt
  ) {
    throw new Error(`content-free DSH attempt evidence returned HTTP ${response.status}`);
  }
  return companionProbeDshEvidenceSchema.parse(record.dsh);
}

function isIsoDate(value: unknown): value is string {
  return typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value) &&
    Number.isFinite(Date.parse(value));
}

function readOptions(): ProbeOptions {
  return {
    report: probeReportPath("chatServiceProbe"),
    serviceUrl: probeCliArg("service-url") ?? process.env.CHAT_SERVICE_URL ?? null,
    internalToken: process.env.INTERNAL_TOKEN ?? null,
    userId: probeCliArg("user-id") ?? process.env.CHAT_SERVICE_PROBE_USER_ID ?? CHAT_PROBE_USER_ID,
    characterId: probeCliArg("character-id") ?? process.env.CHAT_SERVICE_PROBE_CHARACTER_ID ?? null,
    expectedCompanionRuntime: parseExpectedCompanionRuntime(
      probeCliArg("expected-companion-runtime") ??
        process.env.CHAT_SERVICE_PROBE_EXPECTED_COMPANION_RUNTIME,
    ),
  };
}

export function parseExpectedCompanionRuntime(
  value: string | undefined,
): "dsh" {
  const normalized = value?.trim();
  if (!normalized) return "dsh";
  if (normalized === "dsh") return normalized;
  throw new Error("expected companion runtime must be dsh");
}

async function main() {
  const options = readOptions();
  try {
    const report = await runProbe({
      serviceUrl: options.serviceUrl,
      userId: options.userId,
      characterId: options.characterId,
      secret: process.env.CHAT_BFF_SIGNING_SECRET ?? null,
      internalToken: options.internalToken,
      expectedCompanionRuntime: options.expectedCompanionRuntime,
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
    rolloutEvidence: SKIPPED_OP,
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
  internalToken?: string | null;
  expectedCompanionRuntime?: "dsh" | null;
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
    expectedCompanionRuntime: input.expectedCompanionRuntime ?? null,
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
        internalToken: input.internalToken ?? null,
        userId: input.userId,
        characterId: character.id,
        runId: randomUUID(),
        checkedAt,
        expectedCompanionRuntime: input.expectedCompanionRuntime ?? null,
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
export async function signedFetch(input: {
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
  internalToken: string | null;
  userId: string;
  characterId: string;
  runId: string;
  checkedAt: string;
  expectedCompanionRuntime: "dsh" | null;
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
    rolloutEvidence: { ok: false, error: "not attempted" },
    cleanup: { ok: false, error: "not attempted" },
  };
  let sessionId: string | null = null;
  let recallSessionId: string | null = null;
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

    const recallSentinel = `idreamrecall_${createHash("sha256")
      .update(input.runId)
      .digest("hex")
      .slice(0, 32)}`;

    // 2) send message and persist one unique fact for the later recall proof.
    const sendRes = await signedFetch({
      ...input, method: "POST", path: `/api/v1/chat/sessions/${sessionId}/messages`,
      body: JSON.stringify({
        content:
          `Tonight we're in the rooftop garden with Mina. The exact rooftop probe code word is ${recallSentinel}. ` +
          "I feel calm, and we still need to choose the train.",
      }),
      idempotencyKey: `chat-probe:${input.runId}:normal`,
    });
    const sent = (await sendRes.json().catch(() => ({}))) as {
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
    const normalDsh = input.expectedCompanionRuntime === "dsh"
      ? await fetchProbeCompanionAttemptEvidence({
          ...input,
          sessionId,
          messageId: sent.assistantMessageId,
          attempt: sent.attempt ?? 1,
          mode: "normal",
        })
      : undefined;
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

    // 5) Recall from a new session. Its PreparedTurn contains no seed turn, so
    // the exact marker can arrive only through the relationship igrep workspace.
    const recallCreateRes = await signedFetch({
      ...input,
      method: "POST",
      path: "/api/v1/chat/sessions",
      body: JSON.stringify({ characterId: input.characterId }),
    });
    const recallSession = (await recallCreateRes.json().catch(() => ({}))) as { id?: string };
    if (recallCreateRes.status !== 201 || !recallSession.id) {
      throw new Error(`recall session create failed: HTTP ${recallCreateRes.status}`);
    }
    recallSessionId = recallSession.id;
    const recallSend = await signedFetch({
      ...input,
      method: "POST",
      path: `/api/v1/chat/sessions/${recallSessionId}/messages`,
      body: JSON.stringify({
        content:
          'Call memory_search with query exactly "exact rooftop probe code word". ' +
          "Use only that tool result to recall the code word from a prior session, then say it exactly.",
      }),
      idempotencyKey: `chat-probe:${input.runId}:cross-session-recall`,
    });
    const recallTurn = (await recallSend.json().catch(() => ({}))) as {
      assistantMessageId?: string;
      attempt?: number;
    };
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
      requireMemoryExtracted: true,
    });
    const recallDsh = input.expectedCompanionRuntime === "dsh"
      ? await fetchProbeCompanionAttemptEvidence({
          ...input,
          sessionId: recallSessionId,
          messageId: recallTurn.assistantMessageId,
          attempt: recallTurn.attempt ?? 1,
          mode: "normal",
        })
      : undefined;
    const recall = input.expectedCompanionRuntime === "dsh"
      ? evaluateDshRecallEvidence({
          assistantContent: recallState.message?.content,
          sentinel: recallSentinel,
          dsh: recallDsh,
        })
      : { ok: true, recallMatched: true, wakeObserved: true, memorySearchHit: true };
    if (recallState.status !== 200 || recallState.settled !== true || !recall.ok || !(recallDsh?.ok ?? true)) {
      throw new Error(
        `cross-session recall failed: HTTP ${recallState.status}; settled=${recallState.settled === true}; ` +
        `dsh=${recallDsh?.ok ?? "not_required"}; ${describeDshRecallFailure(recall, recallDsh)}`,
      );
    }

    // 6) Create a later Scene revision in the seed session, then regenerate
    // the first assistant attempt. The regenerated PreparedTurn must retain
    // its original user anchor (Scene v0), not the later Scene head.
    const futureSend = await signedFetch({
      ...input,
      method: "POST",
      path: `/api/v1/chat/sessions/${sessionId}/messages`,
      body: JSON.stringify({
        content: "Move us to the train station at dawn after choosing the train.",
      }),
      idempotencyKey: `chat-probe:${input.runId}:future-scene`,
    });
    const futureTurn = (await futureSend.json().catch(() => ({}))) as {
      assistantMessageId?: string;
      attempt?: number;
      userMessageId?: string;
    };
    const futureStream = futureTurn.assistantMessageId
      ? await probeStream({
          ...input,
          assistantMessageId: futureTurn.assistantMessageId,
          expectedAttempt: futureTurn.attempt ?? 1,
        })
      : { ok: false, error: "missing future assistantMessageId" };
    if (futureSend.status !== 202 || !futureTurn.assistantMessageId || !futureStream.ok) {
      const failure = futureSend.status !== 202
        ? `future scene send failed: HTTP ${futureSend.status}`
        : `future scene stream failed: ${futureStream.error ?? "terminal event missing"}`;
      evidence.regenerateAnchor = {
        ok: false,
        status: futureSend.status,
        ...(futureTurn.assistantMessageId
          ? { assistantMessageId: futureTurn.assistantMessageId }
          : {}),
        error: failure,
      };
      // INVARIANT: do not issue regenerate/no-memory writes while this turn may
      // still be generating or retrying. Cleanup owns the one safe exit path.
      throw new Error(failure);
    }
    const futureState = futureTurn.assistantMessageId
      ? await waitForSessionMessage({
          ...input,
          sessionId,
          assistantMessageId: futureTurn.assistantMessageId,
          requireMemoryExtracted: true,
        })
      : { status: 0, message: null, settled: false };
    const originalSceneVersion = sceneVersion(assistant?.scene);
    const futureUserSceneVersion = futureState.messages?.find(
      (message) => message.id === futureTurn.userMessageId,
    )?.sceneVersion ?? null;
    const futureSceneVersion = sceneVersion(futureState.message?.scene);
    const futureSceneAdvanced = isRelativeFutureSceneAnchor({
      originalSceneVersion,
      futureUserSceneVersion,
      futureSceneVersion,
    });
    const futureDsh = input.expectedCompanionRuntime === "dsh"
      ? await fetchProbeCompanionAttemptEvidence({
          ...input,
          sessionId,
          messageId: futureTurn.assistantMessageId,
          attempt: futureTurn.attempt ?? 1,
          mode: "normal",
        })
      : undefined;
    const futureReady =
      futureState.status === 200 &&
      futureState.settled === true &&
      futureSceneAdvanced &&
      recall.ok &&
      (futureDsh?.ok ?? true);
    if (!futureReady) {
      const failure =
        `future scene terminal state failed: HTTP ${futureState.status}; ` +
        `settled=${futureState.settled === true}; scenes=${originalSceneVersion}/${futureUserSceneVersion}/${futureSceneVersion}; ` +
        `dsh=${futureDsh?.ok ?? "not_required"}; recall=${recall.ok}`;
      evidence.regenerateAnchor = {
        ok: false,
        status: futureState.status,
        assistantMessageId: futureTurn.assistantMessageId,
        originalAttempt: assistant?.attempt,
        originalSceneVersion,
        futureUserSceneVersion,
        futureSceneVersion,
        recallMatched: recall.recallMatched,
        wakeObserved: recall.wakeObserved,
        memorySearchHit: recall.memorySearchHit,
        ...(futureDsh ? { futureDsh } : {}),
        error: failure,
      };
      throw new Error(failure);
    }
    const regenerate = await signedFetch({
      ...input,
      method: "POST",
      path: `/api/v1/chat/messages/${sent.assistantMessageId}/regenerate`,
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
        originalAttempt: assistant?.attempt,
        originalSceneVersion,
        futureUserSceneVersion,
        futureSceneVersion,
        ...(futureDsh ? { futureDsh } : {}),
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
        originalAttempt: assistant?.attempt,
        regeneratedAttempt: regenerated.attempt,
        originalSceneVersion,
        futureUserSceneVersion,
        futureSceneVersion,
        ...(futureDsh ? { futureDsh } : {}),
        error: failure,
      };
      throw new Error(failure);
    }
    const regeneratedState = regenerated.assistantMessageId
      ? await waitForSessionMessage({
          ...input,
          sessionId,
          assistantMessageId: regenerated.assistantMessageId,
          requireMemoryExtracted: true,
        })
      : { status: 0, message: null, settled: false };
    const regeneratedSceneVersion = sceneVersion(regeneratedState.message?.scene);
    const regeneratedDsh = input.expectedCompanionRuntime === "dsh"
      ? await fetchProbeCompanionAttemptEvidence({
          ...input,
          sessionId,
          messageId: regenerated.assistantMessageId!,
          attempt: regenerated.attempt ?? regeneratedState.message?.attempt ?? 1,
          mode: "normal",
        })
      : undefined;
    evidence.regenerateAnchor = {
      ok:
        futureSend.status === 202 &&
        futureStream.ok &&
        futureState.settled === true &&
        regenerate.status === 202 &&
        regeneratedStream.ok &&
        regeneratedState.settled === true &&
        futureSceneAdvanced &&
        recall.ok &&
        regeneratedSceneVersion === originalSceneVersion &&
        regeneratedState.message?.attempt === regenerated.attempt &&
        (futureDsh?.ok ?? true) &&
        (regeneratedDsh?.ok ?? true),
      status: regenerate.status,
      assistantMessageId: regenerated.assistantMessageId,
      originalAttempt: assistant?.attempt,
      regeneratedAttempt: regeneratedState.message?.attempt,
      originalSceneVersion,
      futureUserSceneVersion,
      futureSceneVersion,
      regeneratedSceneVersion,
      recallMatched: recall.recallMatched,
      wakeObserved: recall.wakeObserved,
      memorySearchHit: recall.memorySearchHit,
      ...(futureDsh ? { futureDsh } : {}),
      ...(regeneratedDsh ? { regeneratedDsh } : {}),
      error:
        futureStream.ok &&
        regeneratedStream.ok &&
        futureSceneAdvanced &&
        recall.ok &&
        regeneratedSceneVersion === originalSceneVersion &&
        (futureDsh?.ok ?? true) &&
        (regeneratedDsh?.ok ?? true)
          ? null
          : `futureStream=${futureStream.ok}; futureSettled=${futureState.settled}; regenerateStream=${regeneratedStream.ok}; regenerateSettled=${regeneratedState.settled}; scenes=${originalSceneVersion}/${futureUserSceneVersion}/${futureSceneVersion}/${regeneratedSceneVersion}; recall=${recall.ok}; futureDsh=${futureDsh?.ok ?? "not_required"}; regeneratedDsh=${regeneratedDsh?.ok ?? "not_required"}`,
    };
    if (!evidence.regenerateAnchor.ok) {
      throw new Error(evidence.regenerateAnchor.error ?? "regenerate evidence failed");
    }

    const relationshipBefore = await readProbeRelationship(input);

    // 7) no-memory smoke: the assistant row must pin disabled even though the
    // session is later restored, with no relationship or memory derivation.
    const disableMemory = await signedFetch({
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
    const noMemSend = await signedFetch({
      ...input, method: "POST", path: `/api/v1/chat/sessions/${sessionId}/messages`,
      body: JSON.stringify({
        content: "incognito probe: please call me ProbeSecret and I like probe tea",
      }),
      idempotencyKey: `chat-probe:${input.runId}:no-memory`,
    });
    const noMemTurn = (await noMemSend.json().catch(() => ({}))) as {
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
    const noMemState = noMemTurn.assistantMessageId
      ? await waitForSessionMessage({
          ...input,
          sessionId,
          assistantMessageId: noMemTurn.assistantMessageId,
          requireMemoryExtracted: false,
        })
      : { status: 0, message: null };
    const relationshipAfter = await readProbeRelationship(input);
    const authorityPinned =
      noMemState.message?.memoryAuthority === "disabled" &&
      noMemState.message.memoryExtractedAttempt === 0;
    const relationshipUnchanged =
      relationshipFingerprint(relationshipAfter) ===
      relationshipFingerprint(relationshipBefore);
    const privateDsh = input.expectedCompanionRuntime === "dsh"
      ? await fetchProbeCompanionAttemptEvidence({
          ...input,
          sessionId,
          messageId: noMemTurn.assistantMessageId,
          attempt: noMemTurn.attempt ?? 1,
          mode: "private",
        })
      : undefined;
    evidence.noMemory = {
      ok:
        disableMemory.status === 200 &&
        noMemSend.status === 202 &&
        noMemStream.ok &&
        authorityPinned &&
        relationshipUnchanged &&
        (privateDsh?.ok ?? true),
      status: noMemSend.status,
      assistantMessageId: noMemTurn.assistantMessageId,
      authorityPinned,
      relationshipUnchanged,
      ...(privateDsh ? { dsh: privateDsh } : {}),
      error:
        disableMemory.status === 200 &&
        noMemStream.ok &&
        authorityPinned &&
        relationshipUnchanged &&
        (privateDsh?.ok ?? true)
        ? null
        : `disable=${disableMemory.status}; stream=${noMemStream.ok}; authority=${authorityPinned}; relationship=${relationshipUnchanged}; privateDsh=${privateDsh?.ok ?? "not_required"}`,
    };
    if (!evidence.noMemory.ok) {
      throw new Error(evidence.noMemory.error ?? "private no-memory evidence failed");
    }

    // 8) blocked-input smoke: the mock/safety provider blocks the underage keyword.
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
    evidence.rolloutEvidence = await collectProbeRolloutEvidenceBeforeCleanup({
      serviceUrl: input.serviceUrl,
      internalToken: input.internalToken,
      userId: input.userId,
      checkedAt: input.checkedAt,
      expectedCompanionRuntime: input.expectedCompanionRuntime,
    });
    if (!evidence.rolloutEvidence.ok && !evidence.error) {
      evidence.error =
        evidence.rolloutEvidence.error ?? "pre-cleanup Gate R evidence failed";
    }
    evidence.cleanup = await cleanupCompletedProbeState({
      ...input,
      sessionId,
      additionalSessionIds: recallSessionId ? [recallSessionId] : [],
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

/**
 * SPEC: Gate E must snapshot Gate R's aggregate audit evidence before privacy
 * cleanup removes the probe MessageVersions. The exact audit actor and window
 * are part of the request authority; neither raw turns nor actor ids enter the
 * returned report.
 */
export async function collectProbeRolloutEvidenceBeforeCleanup(input: {
  serviceUrl: string;
  internalToken: string | null;
  userId: string;
  checkedAt: string;
  expectedCompanionRuntime: "dsh" | null;
  now?: () => Date;
  fetchImpl?: (
    input: URL | RequestInfo,
    init?: RequestInit,
  ) => Promise<Response>;
}): Promise<ProbeRolloutEvidence> {
  const collectedAt = (input.now ?? (() => new Date()))().toISOString();
  let status: number | undefined;
  try {
    if (input.userId !== CHAT_PROBE_USER_ID) {
      throw new Error("Gate R internal-audit aggregate requires the dedicated probe actor");
    }
    if (!input.internalToken?.trim()) {
      throw new Error("INTERNAL_TOKEN is required for pre-cleanup Gate R evidence");
    }
    if (!isIsoDate(input.checkedAt) || Date.parse(collectedAt) <= Date.parse(input.checkedAt)) {
      throw new Error("Gate R internal-audit aggregate requires a non-empty checkedAt window");
    }
    const url = new URL(
      "/internal/admin/companion-rollout-evidence",
      normalizedBase(input.serviceUrl),
    );
    url.searchParams.set("from", input.checkedAt);
    url.searchParams.set("to", collectedAt);
    url.searchParams.set("scope", "internal-audit");
    url.searchParams.set("userId", CHAT_PROBE_USER_ID);
    const response = await (input.fetchImpl ?? fetch)(url, {
      method: "GET",
      headers: { "x-internal-token": input.internalToken },
    });
    status = response.status;
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(`Gate R internal-audit aggregate returned HTTP ${response.status}`);
    }
    const aggregate = validateProbeRolloutAggregate(body, {
      from: input.checkedAt,
      to: collectedAt,
      expectedRuntime: "dsh",
    });
    return {
      ok: true,
      status: response.status,
      collectedAt,
      aggregate,
      error: null,
    };
  } catch (error) {
    return {
      ok: false,
      ...(status === undefined ? {} : { status }),
      collectedAt,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function validateProbeRolloutAggregate(
  value: unknown,
  expected: { from: string; to: string; expectedRuntime: "dsh" },
): ProbeRolloutAggregate {
  const aggregate = isRecord(value) ? value : {};
  const window = isRecord(aggregate.window) ? aggregate.window : {};
  const decision = isRecord(aggregate.releaseDecision)
    ? aggregate.releaseDecision
    : {};
  const runtimes = isRecord(aggregate.runtimes) ? aggregate.runtimes : {};
  const native = isRecord(runtimes.native) ? runtimes.native : {};
  const dsh = isRecord(runtimes.dsh) ? runtimes.dsh : {};
  const scope = isRecord(aggregate.dataScope) ? aggregate.dataScope : {};
  const nativeAttempts = native.attempts;
  const dshAttempts = dsh.attempts;
  const expectedAttempts = dshAttempts;
  const valid =
    aggregate.schemaVersion === 1 &&
    window.from === expected.from &&
    window.to === expected.to &&
    decision.status === "not_evaluated" &&
    typeof nativeAttempts === "number" &&
    Number.isInteger(nativeAttempts) &&
    nativeAttempts >= 0 &&
    typeof dshAttempts === "number" &&
    Number.isInteger(dshAttempts) &&
    dshAttempts >= 0 &&
    typeof expectedAttempts === "number" &&
    expectedAttempts > 0 &&
    scope.userAuthority === "core.chat_user_view" &&
    scope.scope === "internal-audit" &&
    scope.includedDataClass === "audit" &&
    scope.activeCustomersOnly === false &&
    scope.exactAuditActorOnly === true &&
    scope.userFilterApplied === true &&
    scope.windowBasis === "message_versions.created_at";
  if (!valid) {
    throw new Error(
      `Gate R internal-audit aggregate is not attributable to the probe window/runtime (${expected.expectedRuntime})`,
    );
  }
  return value as ProbeRolloutAggregate;
}

export async function cleanupExistingProbeState(input: {
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

export async function cleanupCompletedProbeState(input: {
  serviceUrl: string;
  secret: string;
  userId: string;
  characterId: string;
  sessionId: string | null;
  additionalSessionIds?: readonly string[];
}): Promise<CleanupEvidence> {
  if (!input.sessionId) {
    return {
      ok: false,
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
    const sessionIds = [input.sessionId, ...(input.additionalSessionIds ?? [])];
    const deleted: Response[] = [];
    for (const targetSessionId of sessionIds) {
      deleted.push(await signedFetch({
        ...input,
        method: "DELETE",
        path: `/api/v1/chat/sessions/${targetSessionId}`,
      }));
    }
    const fileAuthority = await clearProbeFileAuthority(input);
    const verify: Response[] = [];
    for (const targetSessionId of sessionIds) {
      verify.push(await signedFetch({
        ...input,
        method: "GET",
        path: `/api/v1/chat/sessions/${targetSessionId}`,
      }));
    }
    const sessionDeleted = deleted.every((response) => response.status === 200);
    const relationshipDeleted = fileAuthority.relationshipsGone === true;
    const sessionGone = verify.every((response) => response.status === 404);
    const ok =
      restore.status === 200 &&
      sessionDeleted &&
      fileAuthority.ok &&
      relationshipDeleted &&
      sessionGone;
    return {
      ok,
      status: verify[0]?.status,
      sessionDeleted,
      relationshipDeleted,
      relationshipsDeleted: fileAuthority.relationshipsDeleted,
      relationshipsGone: fileAuthority.relationshipsGone,
      sessionGone,
      error: ok
        ? null
        : `restore=${restore.status}; delete=${deleted.map((response) => response.status).join(",")}; fileAuthority=${fileAuthority.error ?? fileAuthority.ok}; verify=${verify.map((response) => response.status).join(",")}`,
    };
  } catch (error) {
    return {
      ok: false,
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
    const relationshipResponse = await signedFetch({
      ...input,
      method: "GET",
      path: "/api/v1/chat/relationships",
    });
    const relationshipBody = (
      await relationshipResponse.json().catch(() => ({}))
    ) as {
      relationships?: Array<{ characterId?: string }>;
    };
    if (
      relationshipResponse.status !== 200 ||
      !Array.isArray(relationshipBody.relationships)
    ) {
      return {
        ok: false,
        relationshipDeleted: false,
        relationshipsGone: false,
        error: `list relationships=${relationshipResponse.status}`,
      };
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
          relationshipsDeleted,
          relationshipDeleted: false,
          relationshipsGone: false,
          error: `could not delete audit relationship ${relationship.characterId}: HTTP ${response.status}`,
        };
      }
      relationshipsDeleted += 1;
    }

    const relationshipVerify = await signedFetch({
      ...input,
      method: "GET",
      path: "/api/v1/chat/relationships",
    });
    const verifiedRelationships = (
      await relationshipVerify.json().catch(() => ({}))
    ) as {
      relationships?: unknown[];
    };
    const relationshipsGone =
      relationshipVerify.status === 200 &&
      Array.isArray(verifiedRelationships.relationships) &&
      verifiedRelationships.relationships.length === 0;
    return {
      ok: relationshipsGone,
      status: relationshipVerify.status,
      relationshipDeleted: relationshipsGone,
      relationshipsDeleted,
      relationshipsGone,
      error:
        relationshipsGone ? null : `verify relationships=${relationshipsGone}`,
    };
  } catch (error) {
    return {
      ok: false,
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
  const deadline = Date.now() + chatServiceProbeSettleTimeoutMs();
  let lastStatus = 0;
  let lastMessage: ProbeSessionMessage | null = null;
  let lastMessages: ProbeSessionMessage[] | undefined;
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
    lastMessages = body.messages;
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
    evidence.rolloutEvidence.ok &&
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
