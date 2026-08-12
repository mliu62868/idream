// SPEC: relationship authority — which user turn authored which assistant reply,
// and how mem/{u}/{c}/relationship.md is rebuilt from scratch once it has been
// deleted. Both exports answer the same question, because PG carries two
// independent pieces of source evidence: messages.reply_to_message_id (modern,
// authoritative) and chat_send_receipts (the send idempotency receipt).
// INTENT: fail closed, never guess. A wrong link attributes one user's turn to
// another reply, which would leak text across an edit/delete boundary. So
// resolveRelationshipLinkage reports a source ONLY when the evidence is
// unanimous and exclusive; everything else comes back as ambiguousAssistantIds +
// candidateSourceIds, and callers refuse the write (edit/regenerate → 409) or
// over-scrub (privacy erases the whole connected component).
// INVARIANTS — resolveRelationshipLinkage:
//   - Disagreement is ambiguity: two receipts for one assistant, a receipt that
//     contradicts reply_to_message_id, or a target that is missing / not a user
//     row / in another session all yield ambiguity, never a best guess.
//   - One user turn is the source authority for at most one assistant row.
//     Duplicate explicit claims are corruption, so ALL claimants go ambiguous.
//   - Rows predating reply_to_message_id fall back to a time window bounded by
//     the previous assistant in the same session, and are accepted only when
//     that window holds exactly one user row no other assistant also claims.
// INVARIANTS — buildRelationshipProjection: it returns the ordered operation
// list that recreates the entire file after deleteRelationship, so it has to
// reconstruct history the ledger never recorded. Four sources, sorted by an
// ordering that puts reconstructed history strictly before replayed history:
//   - canonical turns  — applied memory_extract rows whose session/user/attempt
//     still match a currently eligible PG turn exactly (real ledger sequence);
//   - manual patches   — applied relationship_set rows (real ledger sequence);
//   - legacy turns     — recovered from the file's own applied_turn_keys, and
//     failing that from its retained summary lines (synthetic sequence −N..−1);
//   - cutover baseline — a content-free aggregate (synthetic sequence, strictly
//     lowest). Everything at or before the newest relationship_delete sequence
//     is then dropped: a reset is an epoch boundary, not a filter.
// The baseline exists because relationship.md predates this ledger: pre-cutover
// turns were applied straight to the file with no row to replay. Dropping them
// would visibly regress a long-running bond, and fabricating their prose is not
// an option, so the rebuild retains ONLY the counters plus candidateAssistantIds
// — the still-eligible assistant turns that nothing else explains. Those ids are
// what let a later delete/edit shrink the aggregate (reconcileCutoverBaseline)
// without the baseline ever having stored a word of the text it stands for.
// Summary-line recovery works the same way round: recompute the line each
// eligible turn WOULD produce, bucket by that exact string, and accept a
// retained line only when its bucket holds exactly one turn. Two turns with
// identical text recover neither — unattributed prose is never copied forward.
import type { Prisma } from "../generated/client/client.js";
import type { ChatPrismaClient } from "./db.js";
import {
  getRelationshipRepairSnapshot,
  relationshipSignalForTurn,
  relationshipTurnSummary,
  type RelationshipCutoverBaseline,
  type RelationshipRepairSnapshot,
} from "./relationship.js";

const relationshipMessageSelect = {
  id: true,
  sessionId: true,
  role: true,
  status: true,
  safetyStatus: true,
  attempt: true,
  content: true,
  replyToMessageId: true,
  memoryAuthority: true,
  memoryExtractedAttempt: true,
  runtimeTrace: true,
  createdAt: true,
  deletedAt: true,
} as const;

export interface RelationshipMessage {
  id: string;
  sessionId: string;
  role: string;
  status: string;
  safetyStatus: string;
  attempt: number;
  content: string;
  replyToMessageId: string | null;
  memoryAuthority: string;
  memoryExtractedAttempt: number;
  runtimeTrace?: unknown;
  createdAt: Date;
  deletedAt: Date | null;
}

export interface RelationshipLinkage {
  /** assistant id → the one user row that is its source of record. */
  sources: Map<string, RelationshipMessage>;
  ambiguousAssistantIds: string[];
  candidateSourceIds: Map<string, string[]>;
}

/**
 * Read both evidence tables for one session and resolve them together. Linkage
 * is only meaningful over a whole session, so these two queries are never
 * separable: issuing them apart invites a caller to resolve messages against
 * another session's receipts.
 */
export async function loadSessionLinkage(
  db: ChatPrismaClient | Prisma.TransactionClient,
  sessionId: string,
): Promise<{
  messages: RelationshipMessage[];
  linkage: RelationshipLinkage;
}> {
  // A transaction adapter owns one pg client; concurrent queries on that
  // client are deprecated and will be rejected by pg 9. Keep this reader valid
  // for both the pooled client and the transaction adapter.
  const messages = await db.message.findMany({
    where: { sessionId },
    select: relationshipMessageSelect,
  });
  const receipts = await db.chatSendReceipt.findMany({
    where: { sessionId },
    select: {
      userMessageId: true,
      assistantMessageId: true,
    },
  });
  return { messages, linkage: resolveRelationshipLinkage(messages, receipts) };
}

export function resolveRelationshipLinkage(
  messages: RelationshipMessage[],
  receipts: Array<{
    userMessageId: string;
    assistantMessageId: string;
  }>,
): RelationshipLinkage {
  const byId = new Map(messages.map((message) => [message.id, message]));
  const receiptSource = new Map<string, string>();
  const receiptCandidates = new Map<string, Set<string>>();
  const ambiguous = new Set<string>();
  for (const receipt of receipts) {
    const candidates =
      receiptCandidates.get(receipt.assistantMessageId) ?? new Set<string>();
    candidates.add(receipt.userMessageId);
    receiptCandidates.set(receipt.assistantMessageId, candidates);
    const existing = receiptSource.get(receipt.assistantMessageId);
    if (existing && existing !== receipt.userMessageId) {
      ambiguous.add(receipt.assistantMessageId);
      continue;
    }
    receiptSource.set(receipt.assistantMessageId, receipt.userMessageId);
  }

  const assistants = messages
    .filter(
      (message) =>
        message.role === "assistant" &&
        !isImmutableOpeningMessage(message),
    )
    .sort(compareMessages);
  const users = messages
    .filter((message) => message.role === "user")
    .sort(compareMessages);
  const sources = new Map<string, RelationshipMessage>();
  const candidateSourceIds = new Map<string, string[]>();
  const explicitClaims = new Map<string, string>();

  for (const assistant of assistants) {
    const receiptId = receiptSource.get(assistant.id);
    if (ambiguous.has(assistant.id)) {
      candidateSourceIds.set(
        assistant.id,
        Array.from(
          new Set([
            ...(receiptCandidates.get(assistant.id) ?? []),
            ...(assistant.replyToMessageId
              ? [assistant.replyToMessageId]
              : []),
          ]),
        ).sort(),
      );
      continue;
    }
    if (
      receiptId &&
      assistant.replyToMessageId &&
      receiptId !== assistant.replyToMessageId
    ) {
      ambiguous.add(assistant.id);
      candidateSourceIds.set(
        assistant.id,
        [assistant.replyToMessageId, receiptId].sort(),
      );
      continue;
    }
    const authoritativeId = assistant.replyToMessageId ?? receiptId;
    if (authoritativeId) {
      const source = byId.get(authoritativeId);
      if (
        !source ||
        source.role !== "user" ||
        source.sessionId !== assistant.sessionId
      ) {
        ambiguous.add(assistant.id);
        candidateSourceIds.set(
          assistant.id,
          [authoritativeId],
        );
        continue;
      }
      explicitClaims.set(assistant.id, source.id);
      continue;
    }
  }

  // One user turn cannot be the source authority for multiple assistant rows.
  // Duplicate explicit claims are corruption, not permission to double-count.
  const assistantsByExplicitSource = new Map<string, string[]>();
  for (const [assistantId, sourceId] of explicitClaims) {
    const claims = assistantsByExplicitSource.get(sourceId) ?? [];
    claims.push(assistantId);
    assistantsByExplicitSource.set(sourceId, claims);
  }
  for (const [sourceId, assistantIds] of assistantsByExplicitSource) {
    if (assistantIds.length === 1) {
      const source = byId.get(sourceId);
      if (source) sources.set(assistantIds[0], source);
      continue;
    }
    for (const assistantId of assistantIds) {
      ambiguous.add(assistantId);
      candidateSourceIds.set(assistantId, [sourceId]);
      explicitClaims.delete(assistantId);
    }
  }

  const legacyCandidates = new Map<string, RelationshipMessage[]>();
  for (const assistant of assistants) {
    if (ambiguous.has(assistant.id) || explicitClaims.has(assistant.id)) {
      continue;
    }
    const assistantAt = assistant.createdAt.getTime();
    const priorTimes = assistants
      .filter(
        (candidate) =>
          candidate.sessionId === assistant.sessionId &&
          candidate.createdAt.getTime() < assistantAt,
      )
      .map((candidate) => candidate.createdAt.getTime());
    const lowerBound =
      priorTimes.length > 0
        ? Math.max(...priorTimes)
        : Number.NEGATIVE_INFINITY;
    const candidates = users.filter((candidate) => {
      const candidateAt = candidate.createdAt.getTime();
      return (
        candidate.sessionId === assistant.sessionId &&
        candidateAt > lowerBound &&
        candidateAt <= assistantAt
      );
    });
    legacyCandidates.set(assistant.id, candidates);
  }

  const candidateClaimCounts = new Map<string, number>();
  for (const sourceId of explicitClaims.values()) {
    candidateClaimCounts.set(
      sourceId,
      (candidateClaimCounts.get(sourceId) ?? 0) + 1,
    );
  }
  for (const candidates of legacyCandidates.values()) {
    for (const candidate of candidates) {
      candidateClaimCounts.set(
        candidate.id,
        (candidateClaimCounts.get(candidate.id) ?? 0) + 1,
      );
    }
  }
  for (const [assistantId, candidates] of legacyCandidates) {
    if (
      candidates.length === 1 &&
      candidateClaimCounts.get(candidates[0].id) === 1
    ) {
      sources.set(assistantId, candidates[0]);
      continue;
    }
    ambiguous.add(assistantId);
    candidateSourceIds.set(
      assistantId,
      candidates.map((candidate) => candidate.id).sort(),
    );
  }

  return {
    sources,
    ambiguousAssistantIds: [...ambiguous].sort(),
    candidateSourceIds,
  };
}

function isImmutableOpeningMessage(message: RelationshipMessage): boolean {
  const trace = message.runtimeTrace;
  return Boolean(
    message.replyToMessageId === null &&
      message.memoryAuthority === "disabled" &&
      trace &&
      typeof trace === "object" &&
      !Array.isArray(trace) &&
      (trace as Record<string, unknown>).schemaVersion === 1 &&
      (trace as Record<string, unknown>).messageKind === "opening" &&
      (trace as Record<string, unknown>).outputAuthority ===
        "immutable_opening",
  );
}

export type RelationshipProjectionOperation =
  | {
      kind: "baseline";
      sequence: bigint;
      baseline: RelationshipCutoverBaseline;
    }
  | {
      kind: "turn";
      sequence: bigint;
      turnKey: string;
      summaryDelta: string;
      warmth: number;
      familiarity: number;
    }
  | {
      kind: "manual";
      sequence: bigint;
      mutationKey: string;
      summary?: string;
      stage?: "new" | "familiar" | "close" | "committed";
    };

export async function buildRelationshipProjection(
  tx: Prisma.TransactionClient,
  input: {
    userId: string;
    characterId: string;
  },
): Promise<RelationshipProjectionOperation[]> {
  const sessions = await tx.chatSession.findMany({
    where: {
      userId: input.userId,
      characterId: input.characterId,
      status: { not: "deleted" },
      deletedAt: null,
    },
    select: {
      id: true,
      messages: { select: relationshipMessageSelect },
      sendReceipts: {
        select: {
          userMessageId: true,
          assistantMessageId: true,
        },
      },
    },
  });

  const ledger = await tx.chatFileMutation.findMany({
    where: {
      userId: input.userId,
      status: "applied",
      kind: {
        in: [
          "memory_extract",
          "relationship_set",
          "relationship_delete",
        ],
      },
    },
    select: { id: true, sequence: true, kind: true, payload: true },
    orderBy: { sequence: "asc" },
  });
  let lastReset: bigint | null = null;
  const extractionRows: Array<{
    sequence: bigint;
    turnKey: string;
    sessionId: string;
    userMessageId: string;
    attempt: number;
  }> = [];
  const manualPatches: Array<
    Extract<RelationshipProjectionOperation, { kind: "manual" }>
  > = [];
  for (const row of ledger) {
    const payload = jsonObject(row.payload);
    if (payload.characterId !== input.characterId) continue;
    if (row.kind === "relationship_delete") {
      lastReset = row.sequence;
      continue;
    }
    if (
      row.kind === "memory_extract" &&
      typeof payload.turnKey === "string" &&
      typeof payload.sessionId === "string" &&
      typeof payload.userMessageId === "string" &&
      typeof payload.attempt === "number" &&
      Number.isInteger(payload.attempt)
    ) {
      extractionRows.push({
        sequence: row.sequence,
        turnKey: payload.turnKey,
        sessionId: payload.sessionId,
        userMessageId: payload.userMessageId,
        attempt: payload.attempt,
      });
      continue;
    }
    if (row.kind === "relationship_set") {
      const summary =
        typeof payload.summary === "string" ? payload.summary : undefined;
      const stage = relationshipStage(payload.stage);
      manualPatches.push({
        kind: "manual",
        sequence: row.sequence,
        mutationKey: row.id,
        ...(summary !== undefined ? { summary } : {}),
        ...(stage !== undefined ? { stage } : {}),
      });
    }
  }

  const epochExtractionRows = extractionRows.filter(
    (row) => lastReset === null || row.sequence > lastReset,
  );
  const extractionAuthority = new Map<
    string,
    (typeof epochExtractionRows)[number]
  >();
  for (const row of epochExtractionRows) {
    extractionAuthority.set(row.turnKey, row);
  }

  const eligibleTurns = new Map<
    string,
    {
      assistant: RelationshipMessage;
      source: RelationshipMessage;
    }
  >();
  for (const session of sessions) {
    const linkage = resolveRelationshipLinkage(
      session.messages,
      session.sendReceipts,
    );
    for (const assistant of session.messages) {
      if (
        assistant.role !== "assistant" ||
        assistant.status !== "sent" ||
        assistant.deletedAt ||
        assistant.memoryAuthority !== "enabled" ||
        assistant.memoryExtractedAttempt < assistant.attempt ||
        !["passed", "unknown"].includes(assistant.safetyStatus)
      ) {
        continue;
      }
      const source = linkage.sources.get(assistant.id);
      if (
        !source ||
        source.status !== "sent" ||
        source.deletedAt ||
        !["passed", "unknown"].includes(source.safetyStatus)
      ) {
        continue;
      }
      eligibleTurns.set(assistant.id, { assistant, source });
    }
  }

  const canonicalTurns: Array<
    Extract<RelationshipProjectionOperation, { kind: "turn" }>
  > = [];
  const replayedAssistantIds = new Set<string>();
  for (const { assistant, source } of eligibleTurns.values()) {
    const extraction = extractionAuthority.get(assistant.id);
    if (
      !extraction ||
      extraction.sessionId !== assistant.sessionId ||
      extraction.userMessageId !== source.id ||
      extraction.attempt !== assistant.attempt
    ) {
      continue;
    }
    const signal = relationshipSignalForTurn(source.content);
    canonicalTurns.push({
      kind: "turn",
      sequence: extraction.sequence,
      turnKey: assistant.id,
      summaryDelta: relationshipTurnSummary(source.content),
      warmth: signal.warmth,
      familiarity: signal.familiarity,
    });
    replayedAssistantIds.add(assistant.id);
  }

  const snapshot = await getRelationshipRepairSnapshot(
    input.userId,
    input.characterId,
  );
  const knownAssistantIds = new Set<string>([
    ...sessions.flatMap((session) =>
      session.messages
        .filter((message) => message.role === "assistant")
        .map((message) => message.id),
    ),
    ...epochExtractionRows.map((row) => row.turnKey),
  ]);
  const explicitTurnKeys = Array.from(
    new Set(
      snapshot.appliedTurnKeys.filter(
        (key) => !key.startsWith("manual:"),
      ),
    ),
  );
  const historicalIdentities = new Set(
    epochExtractionRows.map((row) => row.turnKey),
  );
  const legacyTurnsByAssistant = new Map<
    string,
    {
      assistant: RelationshipMessage;
      source: RelationshipMessage;
    }
  >();
  for (const key of explicitTurnKeys) {
    const identity = resolveLegacyTurnKey(
      key,
      knownAssistantIds,
    );
    historicalIdentities.add(identity?.assistantId ?? `legacy:${key}`);
    if (
      !identity ||
      replayedAssistantIds.has(identity.assistantId)
    ) {
      continue;
    }
    const eligible = eligibleTurns.get(identity.assistantId);
    if (
      !eligible ||
      (
        identity.attempt !== null &&
        identity.attempt !== eligible.assistant.attempt
      )
    ) {
      continue;
    }
    legacyTurnsByAssistant.set(identity.assistantId, eligible);
    replayedAssistantIds.add(identity.assistantId);
  }

  // A legacy file may predate applied_turn_keys entirely. Only an exact,
  // unique match between a retained summary line and a currently eligible
  // source can recover textual history. Unattributed prose is intentionally
  // not copied into the repaired projection.
  const candidatesBySummary = new Map<
    string,
    Array<{
      assistant: RelationshipMessage;
      source: RelationshipMessage;
    }>
  >();
  for (const eligible of eligibleTurns.values()) {
    if (replayedAssistantIds.has(eligible.assistant.id)) continue;
    const summary = relationshipTurnSummary(eligible.source.content);
    const candidates = candidatesBySummary.get(summary) ?? [];
    candidates.push(eligible);
    candidatesBySummary.set(summary, candidates);
  }
  for (const line of snapshot.state.summary
    .split("\n")
    .map((value) => value.trim())
    .filter(Boolean)) {
    const candidates = candidatesBySummary.get(line) ?? [];
    if (candidates.length !== 1) continue;
    const eligible = candidates[0];
    if (replayedAssistantIds.has(eligible.assistant.id)) continue;
    legacyTurnsByAssistant.set(eligible.assistant.id, eligible);
    replayedAssistantIds.add(eligible.assistant.id);
    historicalIdentities.add(eligible.assistant.id);
  }

  const legacyTurns = [...legacyTurnsByAssistant.values()]
    .sort((left, right) =>
      compareMessages(left.assistant, right.assistant),
    )
    .map<
      Extract<RelationshipProjectionOperation, { kind: "turn" }>
    >((eligible, index, all) => {
      const signal = relationshipSignalForTurn(eligible.source.content);
      return {
        kind: "turn",
        sequence: BigInt(index - all.length),
        turnKey: eligible.assistant.id,
        summaryDelta: relationshipTurnSummary(eligible.source.content),
        warmth: signal.warmth,
        familiarity: signal.familiarity,
      };
    });

  const resetSequence = lastReset?.toString() ?? null;
  let baseline: RelationshipCutoverBaseline | null = null;
  if (
    snapshot.cutoverBaseline?.resetSequence === resetSequence
  ) {
    baseline = reconcileCutoverBaseline(
      snapshot.cutoverBaseline,
      eligibleTurns,
      replayedAssistantIds,
    );
  } else if (snapshot.exists) {
    baseline = createCutoverBaseline({
      snapshot,
      resetSequence,
      hasPriorReset: lastReset !== null,
      historicalIdentities,
      eligibleTurns,
      replayedAssistantIds,
    });
  }

  const baselineOperation: RelationshipProjectionOperation[] =
    baseline
      ? [
          {
            kind: "baseline",
            sequence: BigInt(-legacyTurns.length - 1),
            baseline,
          },
        ]
      : [];
  return [
    ...baselineOperation,
    ...legacyTurns,
    ...canonicalTurns,
    ...manualPatches,
  ]
    .filter(
      (operation) =>
        operation.kind === "baseline" ||
        operation.sequence < 0 ||
        lastReset === null ||
        operation.sequence > lastReset,
    )
    .sort((left, right) =>
      left.sequence < right.sequence
        ? -1
        : left.sequence > right.sequence
          ? 1
          : 0,
    );
}

function resolveLegacyTurnKey(
  key: string,
  knownAssistantIds: Set<string>,
): { assistantId: string; attempt: number | null } | null {
  if (knownAssistantIds.has(key)) {
    return { assistantId: key, attempt: null };
  }
  const matches = [...knownAssistantIds]
    .filter((assistantId) => {
      if (!key.startsWith(`${assistantId}:`)) return false;
      return /^\d+$/.test(key.slice(assistantId.length + 1));
    })
    .sort((left, right) => right.length - left.length);
  const assistantId = matches[0];
  if (!assistantId) return null;
  return {
    assistantId,
    attempt: Number.parseInt(
      key.slice(assistantId.length + 1),
      10,
    ),
  };
}

function createCutoverBaseline(input: {
  snapshot: RelationshipRepairSnapshot;
  resetSequence: string | null;
  hasPriorReset: boolean;
  historicalIdentities: Set<string>;
  eligibleTurns: Map<
    string,
    {
      assistant: RelationshipMessage;
      source: RelationshipMessage;
    }
  >;
  replayedAssistantIds: Set<string>;
}): RelationshipCutoverBaseline {
  if (input.hasPriorReset) {
    return {
      authorityVersion: 1,
      resetSequence: input.resetSequence,
      signals: { warmth: 0, familiarity: 0, turns: 0 },
      candidateAssistantIds: [],
      version: input.snapshot.state.version,
    };
  }

  const explainedTurns = Math.min(
    input.snapshot.state.signals.turns,
    input.historicalIdentities.size,
  );
  const residualTurns =
    input.snapshot.state.signals.turns - explainedTurns;
  const candidateAssistantIds = [...input.eligibleTurns.keys()]
    .filter(
      (assistantId) =>
        !input.historicalIdentities.has(assistantId) &&
        !input.replayedAssistantIds.has(assistantId),
    )
    .sort();
  const retainedTurns = Math.min(
    residualTurns,
    candidateAssistantIds.length,
  );
  const removedTurns =
    explainedTurns + (residualTurns - retainedTurns);
  return {
    authorityVersion: 1,
    resetSequence: input.resetSequence,
    signals: {
      warmth: Math.max(
        0,
        input.snapshot.state.signals.warmth - removedTurns,
      ),
      familiarity: Math.max(
        0,
        input.snapshot.state.signals.familiarity - removedTurns,
      ),
      turns: retainedTurns,
    },
    candidateAssistantIds,
    version: input.snapshot.state.version,
  };
}

function reconcileCutoverBaseline(
  baseline: RelationshipCutoverBaseline,
  eligibleTurns: Map<
    string,
    {
      assistant: RelationshipMessage;
      source: RelationshipMessage;
    }
  >,
  replayedAssistantIds: Set<string>,
): RelationshipCutoverBaseline {
  const candidateSet = new Set(baseline.candidateAssistantIds);
  const migratedTurns = Math.min(
    baseline.signals.turns,
    [...replayedAssistantIds].filter((assistantId) =>
      candidateSet.has(assistantId),
    ).length,
  );
  const afterMigration =
    baseline.signals.turns - migratedTurns;
  const candidateAssistantIds = baseline.candidateAssistantIds
    .filter(
      (assistantId) =>
        !replayedAssistantIds.has(assistantId) &&
        eligibleTurns.has(assistantId),
    )
    .sort();
  const retainedTurns = Math.min(
    afterMigration,
    candidateAssistantIds.length,
  );
  const removedTurns =
    migratedTurns + (afterMigration - retainedTurns);
  return {
    ...baseline,
    signals: {
      warmth: Math.max(
        0,
        baseline.signals.warmth - removedTurns,
      ),
      familiarity: Math.max(
        0,
        baseline.signals.familiarity - removedTurns,
      ),
      turns: retainedTurns,
    },
    candidateAssistantIds,
  };
}

function compareMessages(
  left: RelationshipMessage,
  right: RelationshipMessage,
): number {
  const byTime = left.createdAt.getTime() - right.createdAt.getTime();
  return byTime || left.id.localeCompare(right.id);
}

function jsonObject(value: Prisma.JsonValue): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function relationshipStage(
  value: unknown,
): "new" | "familiar" | "close" | "committed" | undefined {
  return value === "new" ||
    value === "familiar" ||
    value === "close" ||
    value === "committed"
    ? value
    : undefined;
}
