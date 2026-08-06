// SPEC: relationship.md derivation (P1-2, design §5, PRD §7.3). File-layer
// authority (NOT PG). Each turn merges signals + advances stage; narrative summary
// appended. Read-merge-atomic-write so the single chat.memory.extract writer never
// races itself. Used by the model for tone/continuity, not exposed as a game score.
import path from "node:path";
import {
  readWhole,
  appendLine,
  writeAtomic,
  chatFsPaths,
  listPrefix,
  deletePrefix,
  withFileMutationLock,
} from "./chat-fs.js";

export type RelationshipStage = "new" | "familiar" | "close" | "committed";

export interface RelationshipState {
  stage: RelationshipStage;
  signals: { warmth: number; familiarity: number; turns: number };
  summary: string;
  version: number;
}

export type RelationshipEvidenceKind =
  | "self_disclosure"
  | "trust"
  | "affection"
  | "shared_plan"
  | "conflict"
  | "repair"
  | "boundary_respected";

export interface RelationshipEvidence {
  sourceAssistantMessageId: string;
  sourceUserMessageId: string;
  kind: RelationshipEvidenceKind;
  confidence: number;
  extractorVersion: string;
}

/**
 * Content-free authority retained when a pre-ledger relationship file is
 * repaired. Candidate ids bound the unattributed aggregate to turns that were
 * still provably eligible at cutover; later edits/deletes can therefore reduce
 * the aggregate without retaining or reconstructing deleted prose.
 */
export interface RelationshipCutoverBaseline {
  authorityVersion: 1;
  resetSequence: string | null;
  signals: { warmth: number; familiarity: number; turns: number };
  candidateAssistantIds: string[];
  version: number;
}

const STAGE_ORDER: RelationshipStage[] = ["new", "familiar", "close", "committed"];
const STAGE_THRESHOLDS: Record<RelationshipStage, number> = {
  new: 0,
  familiar: 6,
  close: 20,
  committed: 50,
};

const WARMTH_SIGNAL_PATTERNS = [
  /\b(?:i\s+(?:really\s+)?(?:love|miss|trust|adore)\s+you|i\s+care\s+about\s+you|you\s+(?:mean|matter)\s+(?:so\s+)?much\s+to\s+me|i\s+feel\s+safe\s+with\s+you)\b/i,
  /我(?:很|真的|好)?(?:爱|喜欢|想念|信任|在乎)你|我(?:很|真的|好)?想你(?:了|啦|啊|呀|哦|呢)?(?:$|[，。！？])|你对我(?:很)?重要|和你在一起[^。！？]*安心/u,
];

const FAMILIARITY_SIGNAL_PATTERNS = [
  /\b(?:call\s+me|my\s+(?:favorite|name|job|work|family|home|birthday|hobby|fear|dream)|i\s+(?:like|prefer|work|live|grew\s+up|feel|am\s+from))\b/i,
  /我(?:叫|喜欢|偏好|住在|来自|最喜欢|害怕)|我的(?:家人|工作|生日|爱好|梦想|家乡)/u,
];

const EMPTY: RelationshipState = {
  stage: "new",
  signals: { warmth: 0, familiarity: 0, turns: 0 },
  summary: "",
  version: 0,
};

const EVIDENCE_WEIGHT: Record<
  RelationshipEvidenceKind,
  { warmth: number; familiarity: number }
> = {
  self_disclosure: { warmth: 0, familiarity: 2 },
  trust: { warmth: 2, familiarity: 0 },
  affection: { warmth: 3, familiarity: 0 },
  shared_plan: { warmth: 0, familiarity: 2 },
  conflict: { warmth: -2, familiarity: 0 },
  repair: { warmth: 2, familiarity: 0 },
  boundary_respected: { warmth: 0, familiarity: 1 },
};

const STAGE_DEMOTION_THRESHOLDS: Record<RelationshipStage, number> = {
  new: 0,
  familiar: 4,
  close: 16,
  committed: 44,
};

export function emptyRelationshipState(): RelationshipState {
  return { ...EMPTY, signals: { ...EMPTY.signals } };
}

/**
 * SPEC: Relationship stage is a deterministic projection of source-linked
 * evidence. Evidence retries are idempotent and a single assistant turn cannot
 * skip stages even when it carries several strong evidence kinds.
 */
export function reduceRelationship(
  previous: RelationshipState,
  evidence: RelationshipEvidence[],
): RelationshipState {
  const unique = new Map<string, RelationshipEvidence>();
  for (const item of evidence) {
    if (!validEvidence(item)) continue;
    unique.set(evidenceKey(item), item);
  }
  const byTurn = new Map<string, RelationshipEvidence[]>();
  for (const item of unique.values()) {
    const rows = byTurn.get(item.sourceAssistantMessageId) ?? [];
    rows.push(item);
    byTurn.set(item.sourceAssistantMessageId, rows);
  }

  let state: RelationshipState = {
    ...previous,
    signals: { ...previous.signals },
  };
  for (const turnEvidence of byTurn.values()) {
    let warmth = state.signals.warmth;
    let familiarity = state.signals.familiarity;
    for (const item of turnEvidence) {
      const weight = EVIDENCE_WEIGHT[item.kind];
      warmth += Math.round(weight.warmth * item.confidence);
      familiarity += Math.round(weight.familiarity * item.confidence);
    }
    const signals = {
      warmth: Math.max(0, warmth),
      familiarity: Math.max(0, familiarity),
      turns: state.signals.turns + 1,
    };
    state = {
      stage: projectStageWithHysteresis(
        state.stage,
        signals.warmth + signals.familiarity,
      ),
      signals,
      summary: state.summary,
      version: state.version + 1,
    };
  }
  const summary = evidenceSummary([...unique.values()].map((item) => item.kind));
  return { ...state, summary: summary || previous.summary };
}

export function relationshipEvidenceForTurn(input: {
  userMessageId: string;
  assistantMessageId: string;
  userText: string;
  assistantText: string;
}): RelationshipEvidence[] {
  const kinds = new Set<RelationshipEvidenceKind>();
  const user = input.userText.trim().replace(/\s+/g, " ");
  const assistant = input.assistantText.trim().replace(/\s+/g, " ");
  if (WARMTH_SIGNAL_PATTERNS.some((pattern) => pattern.test(user))) {
    kinds.add(/trust|safe|信任|安心/i.test(user) ? "trust" : "affection");
  }
  if (FAMILIARITY_SIGNAL_PATTERNS.some((pattern) => pattern.test(user))) {
    kinds.add("self_disclosure");
  }
  if (/\b(?:we should|let'?s|our plan)\b|(?:我们|一起)(?:计划|下次|以后)/iu.test(user)) {
    kinds.add("shared_plan");
  }
  if (/\b(?:i disagree|that hurt|i'?m upset|you ignored)\b|我(?:不同意|生气|受伤)|你(?:忽略|没听)/iu.test(user)) {
    kinds.add("conflict");
  }
  if (/\b(?:i'?m sorry|let'?s try again|make this right)\b|对不起|重新来|和好/iu.test(user + " " + assistant)) {
    kinds.add("repair");
  }
  if (/\b(?:i understand|i won'?t|we can avoid)\b|我明白|我不会|我们可以避开/iu.test(assistant) && /\b(?:don'?t|boundary|avoid)\b|不要|别提|边界/iu.test(user)) {
    kinds.add("boundary_respected");
  }
  return [...kinds].map((kind) => ({
    sourceAssistantMessageId: input.assistantMessageId,
    sourceUserMessageId: input.userMessageId,
    kind,
    confidence: 1,
    extractorVersion: "relationship-evidence-1",
  }));
}

function validEvidence(value: RelationshipEvidence): boolean {
  return Boolean(
    value.sourceAssistantMessageId &&
    value.sourceUserMessageId &&
    value.extractorVersion &&
    Number.isFinite(value.confidence) &&
    value.confidence >= 0 &&
    value.confidence <= 1,
  );
}

function evidenceKey(value: RelationshipEvidence): string {
  return `${value.sourceAssistantMessageId}:${value.kind}:${value.extractorVersion}`;
}

function projectStageWithHysteresis(
  current: RelationshipStage,
  score: number,
): RelationshipStage {
  const currentIndex = STAGE_ORDER.indexOf(current);
  const targetIndex = STAGE_ORDER.indexOf(stageForScore(score));
  if (targetIndex > currentIndex) return STAGE_ORDER[currentIndex + 1] ?? current;
  if (
    targetIndex < currentIndex &&
    score <= STAGE_DEMOTION_THRESHOLDS[current]
  ) {
    return STAGE_ORDER[currentIndex - 1] ?? "new";
  }
  return current;
}

function evidenceSummary(kinds: RelationshipEvidenceKind[]): string {
  const unique = new Set(kinds);
  const phrases: string[] = [];
  if (unique.has("self_disclosure")) phrases.push("meaningful self-disclosure");
  if (unique.has("trust")) phrases.push("expressed trust");
  if (unique.has("affection")) phrases.push("expressed affection");
  if (unique.has("shared_plan")) phrases.push("shared plans");
  if (unique.has("conflict")) phrases.push("open conflict");
  if (unique.has("boundary_respected")) phrases.push("respected boundaries");
  if (unique.has("repair")) phrases.push("successful repair");
  if (phrases.length === 0) return "";
  if (phrases.length === 1) return `The bond reflects ${phrases[0]}.`;
  return `The bond reflects ${phrases.slice(0, -1).join(", ")} and ${phrases.at(-1)}.`;
}

export interface RelationshipPatch {
  warmth?: number;
  familiarity?: number;
  summaryDelta?: string;
}

interface RelationshipDocument {
  state: RelationshipState;
  appliedTurnKeys: string[];
  cutoverBaseline: RelationshipCutoverBaseline | null;
}

export interface RelationshipRepairSnapshot {
  exists: boolean;
  state: RelationshipState;
  appliedTurnKeys: string[];
  cutoverBaseline: RelationshipCutoverBaseline | null;
}

type RelationshipEvidenceLogRecord =
  | { recordType: "baseline"; state: RelationshipState }
  | { recordType: "evidence"; evidence: RelationshipEvidence }
  | { recordType: "remove"; sourceMessageIds: string[] };

export async function appendRelationshipEvidenceOnce(
  userId: string,
  characterId: string,
  evidence: RelationshipEvidence[],
): Promise<{ state: RelationshipState; appended: number }> {
  const rel = chatFsPaths.relationship(userId, characterId);
  const evidencePath = chatFsPaths.relationshipEvidence(userId, characterId);
  return withFileMutationLock(rel, async () => {
    const records = parseEvidenceLog(await readWhole(evidencePath));
    if (!records.some((record) => record.recordType === "baseline")) {
      const baseline: RelationshipEvidenceLogRecord = {
        recordType: "baseline",
        state: parseRelationship(await readWhole(rel)),
      };
      await appendLine(evidencePath, JSON.stringify(baseline));
      records.push(baseline);
    }
    const current = activeEvidence(records);
    const known = new Set(current.map(evidenceKey));
    let appended = 0;
    for (const item of evidence) {
      if (!validEvidence(item) || known.has(evidenceKey(item))) continue;
      const record: RelationshipEvidenceLogRecord = {
        recordType: "evidence",
        evidence: item,
      };
      await appendLine(evidencePath, JSON.stringify(record));
      records.push(record);
      known.add(evidenceKey(item));
      appended += 1;
    }
    const state = stateFromEvidenceLog(records);
    await writeAtomic(
      rel,
      renderRelationship(
        state,
        [...new Set(activeEvidence(records).map((item) => item.sourceAssistantMessageId))],
      ),
    );
    return { state, appended };
  });
}

/** Append tombstones for deleted sources, then rebuild from the canonical log. */
export async function rebuildRelationshipFromEvidence(
  userId: string,
  characterId: string,
  validSourceMessageIds: ReadonlySet<string>,
): Promise<{ state: RelationshipState; evidenceCount: number; hasLedger: boolean }> {
  const rel = chatFsPaths.relationship(userId, characterId);
  const evidencePath = chatFsPaths.relationshipEvidence(userId, characterId);
  return withFileMutationLock(rel, async () => {
    const records = parseEvidenceLog(await readWhole(evidencePath));
    if (records.length === 0) {
      return { state: parseRelationship(await readWhole(rel)), evidenceCount: 0, hasLedger: false };
    }
    const invalid = [...new Set(activeEvidence(records).flatMap((item) =>
      validSourceMessageIds.has(item.sourceAssistantMessageId) &&
      validSourceMessageIds.has(item.sourceUserMessageId)
        ? []
        : [item.sourceAssistantMessageId, item.sourceUserMessageId]
    ))].sort();
    if (invalid.length > 0) {
      const removal: RelationshipEvidenceLogRecord = {
        recordType: "remove",
        sourceMessageIds: invalid,
      };
      await appendLine(evidencePath, JSON.stringify(removal));
      records.push(removal);
    }
    const active = activeEvidence(records);
    const state = stateFromEvidenceLog(records);
    await writeAtomic(
      rel,
      renderRelationship(
        state,
        [...new Set(active.map((item) => item.sourceAssistantMessageId))],
      ),
    );
    return { state, evidenceCount: active.length, hasLedger: true };
  });
}

export async function resetRelationshipEvidenceBaseline(
  userId: string,
  characterId: string,
): Promise<void> {
  const rel = chatFsPaths.relationship(userId, characterId);
  const evidencePath = chatFsPaths.relationshipEvidence(userId, characterId);
  await withFileMutationLock(rel, async () => {
    const baseline: RelationshipEvidenceLogRecord = {
      recordType: "baseline",
      state: parseRelationship(await readWhole(rel)),
    };
    await appendLine(evidencePath, JSON.stringify(baseline));
  });
}

export async function deleteRelationshipEvidence(
  userId: string,
  characterId: string,
): Promise<void> {
  await deletePrefix(chatFsPaths.relationshipEvidence(userId, characterId));
}

function parseEvidenceLog(raw: string | null): RelationshipEvidenceLogRecord[] {
  if (!raw) return [];
  const records: RelationshipEvidenceLogRecord[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line) as RelationshipEvidenceLogRecord;
      if (value.recordType === "baseline" && value.state) records.push(value);
      else if (value.recordType === "evidence" && validEvidence(value.evidence)) records.push(value);
      if (
        value.recordType === "remove" &&
        Array.isArray(value.sourceMessageIds) &&
        value.sourceMessageIds.every((item) => typeof item === "string")
      ) records.push(value);
    } catch {
      // A corrupt line cannot acquire authority; valid records still rebuild.
    }
  }
  return records;
}

function activeEvidence(records: RelationshipEvidenceLogRecord[]): RelationshipEvidence[] {
  const baselineIndex = records.reduce(
    (latest, record, index) => record.recordType === "baseline" ? index : latest,
    -1,
  );
  const removed = new Set(
    records.slice(baselineIndex + 1).flatMap((record) =>
      record.recordType === "remove" ? record.sourceMessageIds : []
    ),
  );
  const unique = new Map<string, RelationshipEvidence>();
  for (const record of records.slice(baselineIndex + 1)) {
    if (record.recordType !== "evidence") continue;
    if (
      removed.has(record.evidence.sourceAssistantMessageId) ||
      removed.has(record.evidence.sourceUserMessageId)
    ) continue;
    unique.set(evidenceKey(record.evidence), record.evidence);
  }
  return [...unique.values()];
}

function stateFromEvidenceLog(records: RelationshipEvidenceLogRecord[]): RelationshipState {
  const baseline = [...records].reverse().find(
    (record): record is Extract<RelationshipEvidenceLogRecord, { recordType: "baseline" }> =>
      record.recordType === "baseline",
  );
  return reduceRelationship(
    baseline?.state ?? emptyRelationshipState(),
    activeEvidence(records),
  );
}

/** Apply one generated turn exactly once. BullMQ is at-least-once, so relationship
 * progression must use the same idempotency key as the memory extraction job. */
export async function updateRelationshipOnce(
  userId: string,
  characterId: string,
  turnKey: string,
  patch: RelationshipPatch,
): Promise<{ state: RelationshipState; applied: boolean }> {
  const rel = chatFsPaths.relationship(userId, characterId);
  return withFileMutationLock(rel, async () => {
    const document = parseRelationshipDocument(await readWhole(rel));
    // Prefix match also catches the legacy `${assistantId}:${attempt}` keys.
    if (
      document.appliedTurnKeys.some(
        (key) => key === turnKey || key.startsWith(`${turnKey}:`),
      )
    ) {
      return { state: document.state, applied: false };
    }
    const current = document.state;
    const signals = {
      warmth: Math.max(0, current.signals.warmth + (patch.warmth ?? 0)),
      familiarity: Math.max(
        0,
        current.signals.familiarity + (patch.familiarity ?? 0),
      ),
      turns: current.signals.turns + 1,
    };
    const score = signals.familiarity + signals.warmth;
    const stage = stageForScore(score);
    const summary = patch.summaryDelta
      ? clampSummary(`${current.summary}\n${patch.summaryDelta}`)
      : current.summary;

    const next: RelationshipState = { stage, signals, summary, version: current.version + 1 };
    await writeAtomic(
      rel,
      renderRelationship(
        next,
        [...document.appliedTurnKeys, turnKey],
        document.cutoverBaseline,
      ),
    );
    return { state: next, applied: true };
  });
}

export function relationshipTurnSummary(text: string): string {
  const normalized = text.trim().replace(/\s+/g, " ");
  return normalized.length <= 200
    ? `User: ${normalized}`
    : `User: ${normalized.slice(0, 199)}…`;
}

/**
 * Relationship progression is deliberately conservative: message volume alone
 * is not a bond. Only explicit relational warmth or meaningful self-disclosure
 * contributes signals; turns remain a separate continuity counter.
 */
export function relationshipSignalForTurn(text: string): {
  warmth: number;
  familiarity: number;
} {
  const normalized = text.trim().replace(/\s+/g, " ");
  return {
    warmth: WARMTH_SIGNAL_PATTERNS.some((pattern) => pattern.test(normalized))
      ? 1
      : 0,
    familiarity: FAMILIARITY_SIGNAL_PATTERNS.some((pattern) =>
      pattern.test(normalized)
    )
      ? 1
      : 0,
  };
}

// ---- user-facing management API (PRD §7.3, §8.2) ----------------------------
// Relationship state is file-layer authority, tenant-partitioned under
// mem/{userId}/{charId}/relationship.md, so reading the caller's own prefix is
// the isolation. Exposed so users can review / edit / reset a companion bond.

export interface RelationshipView extends RelationshipState {
  characterId: string;
}

/** List every companion relationship the user has built. */
export async function listRelationships(userId: string): Promise<RelationshipView[]> {
  const rels = await listPrefix(["mem", userId]);
  const out: RelationshipView[] = [];
  for (const rel of rels) {
    const parts = rel.split(path.sep);
    if (parts[parts.length - 1] !== "relationship.md") continue;
    const characterId = parts[2];
    if (!characterId || characterId === "global") continue;
    const state = parseRelationship(await readWhole(parts));
    out.push({ characterId, ...state });
  }
  return out;
}

/** Read one relationship (EMPTY default if none derived yet). */
export async function getRelationshipState(
  userId: string,
  characterId: string,
): Promise<RelationshipView> {
  const state = parseRelationship(await readWhole(chatFsPaths.relationship(userId, characterId)));
  return { characterId, ...state };
}

/** Internal repair snapshot used while the durable projector holds the user lock. */
export async function getRelationshipRepairSnapshot(
  userId: string,
  characterId: string,
): Promise<RelationshipRepairSnapshot> {
  const raw = await readWhole(
    chatFsPaths.relationship(userId, characterId),
  );
  const document = parseRelationshipDocument(raw);
  return {
    exists: raw !== null,
    state: {
      ...document.state,
      signals: { ...document.state.signals },
    },
    appliedTurnKeys: [...document.appliedTurnKeys],
    cutoverBaseline: document.cutoverBaseline
      ? {
          ...document.cutoverBaseline,
          signals: { ...document.cutoverBaseline.signals },
          candidateAssistantIds: [
            ...document.cutoverBaseline.candidateAssistantIds,
          ],
        }
      : null,
  };
}

/**
 * Establish the content-free base of a canonical rebuild. The caller deletes
 * the previous projection first, so replaying this operation is idempotent.
 */
export async function restoreRelationshipCutoverBaseline(
  userId: string,
  characterId: string,
  baseline: RelationshipCutoverBaseline,
): Promise<void> {
  const rel = chatFsPaths.relationship(userId, characterId);
  await withFileMutationLock(rel, async () => {
    const state: RelationshipState = {
      stage: stageForScore(
        baseline.signals.warmth + baseline.signals.familiarity,
      ),
      signals: { ...baseline.signals },
      summary: "",
      version: baseline.version,
    };
    await writeAtomic(
      rel,
      renderRelationship(state, [], baseline),
    );
  });
}

/** Idempotent manual relationship edit used by the durable file projector. */
export async function setRelationshipOnce(
  userId: string,
  characterId: string,
  mutationKey: string,
  patch: { summary?: string; stage?: RelationshipStage },
): Promise<RelationshipView> {
  // `manual:` prefix keeps operator edits out of buildRelationshipProjection's
  // legacy turn recovery, which only replays keys that name an assistant row.
  const appliedKey = `manual:${mutationKey}`;
  const rel = chatFsPaths.relationship(userId, characterId);
  return withFileMutationLock(rel, async () => {
    const document = parseRelationshipDocument(await readWhole(rel));
    if (document.appliedTurnKeys.includes(appliedKey)) {
      return { characterId, ...document.state };
    }
    const current = document.state;
    const stage = patch.stage && STAGE_ORDER.includes(patch.stage) ? patch.stage : current.stage;
    const summary = patch.summary != null ? clampSummary(patch.summary) : current.summary;
    const next: RelationshipState = { ...current, stage, summary, version: current.version + 1 };
    await writeAtomic(
      rel,
      renderRelationship(
        next,
        [...document.appliedTurnKeys, appliedKey],
        document.cutoverBaseline,
      ),
    );
    return { characterId, ...next };
  });
}

/** Reset (hard-delete) a relationship — removes the authority file. Idempotent. */
export async function deleteRelationship(userId: string, characterId: string): Promise<void> {
  const rel = chatFsPaths.relationship(userId, characterId);
  await withFileMutationLock(rel, () => deletePrefix(rel));
}

export function stageForScore(score: number): RelationshipStage {
  let stage: RelationshipStage = "new";
  for (const s of STAGE_ORDER) {
    if (score >= STAGE_THRESHOLDS[s]) stage = s;
  }
  return stage;
}

/** relationship.md = YAML-ish front-matter + a "## Summary" narrative section. */
export function renderRelationship(
  state: RelationshipState,
  appliedTurnKeys: string[] = [],
  cutoverBaseline: RelationshipCutoverBaseline | null = null,
): string {
  return [
    "---",
    `stage: ${state.stage}`,
    `warmth: ${state.signals.warmth}`,
    `familiarity: ${state.signals.familiarity}`,
    `turns: ${state.signals.turns}`,
    `version: ${state.version}`,
    `applied_turn_keys: ${JSON.stringify(appliedTurnKeys)}`,
    ...(cutoverBaseline
      ? [
          `cutover_baseline: ${JSON.stringify(cutoverBaseline)}`,
        ]
      : []),
    "---",
    "",
    "## Summary",
    state.summary.trim(),
    "",
  ].join("\n");
}

export function parseRelationship(raw: string | null): RelationshipState {
  return parseRelationshipDocument(raw).state;
}

function parseRelationshipDocument(raw: string | null): RelationshipDocument {
  if (!raw) {
    return {
      state: { ...EMPTY, signals: { ...EMPTY.signals } },
      appliedTurnKeys: [],
      cutoverBaseline: null,
    };
  }
  const fm = raw.match(/^---\n([\s\S]*?)\n---/);
  const get = (key: string) => fm?.[1].match(new RegExp(`^${key}:\\s*(.+)$`, "m"))?.[1]?.trim();
  const summary = raw.split("## Summary")[1]?.trim() ?? "";
  const stage = (get("stage") as RelationshipStage) ?? "new";
  const rawKeys = get("applied_turn_keys");
  let appliedTurnKeys: string[] = [];
  if (rawKeys) {
    try {
      const parsed = JSON.parse(rawKeys) as unknown;
      if (Array.isArray(parsed)) appliedTurnKeys = parsed.filter((value): value is string => typeof value === "string");
    } catch {
      appliedTurnKeys = [];
    }
  }
  const cutoverBaseline = parseCutoverBaseline(
    get("cutover_baseline"),
  );
  return {
    state: {
      stage: STAGE_ORDER.includes(stage) ? stage : "new",
      signals: {
        warmth: num(get("warmth")),
        familiarity: num(get("familiarity")),
        turns: num(get("turns")),
      },
      summary,
      version: num(get("version")),
    },
    appliedTurnKeys,
    cutoverBaseline,
  };
}

function parseCutoverBaseline(
  raw: string | undefined,
): RelationshipCutoverBaseline | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return null;
    }
    const candidate = value as Record<string, unknown>;
    const signals =
      candidate.signals &&
      typeof candidate.signals === "object" &&
      !Array.isArray(candidate.signals)
        ? candidate.signals as Record<string, unknown>
        : null;
    const candidateAssistantIds = Array.isArray(
      candidate.candidateAssistantIds,
    )
      ? Array.from(
          new Set(
            candidate.candidateAssistantIds.filter(
              (entry): entry is string =>
                typeof entry === "string" && entry.length > 0,
            ),
          ),
        )
      : null;
    if (
      candidate.authorityVersion !== 1 ||
      !(
        candidate.resetSequence === null ||
        typeof candidate.resetSequence === "string"
      ) ||
      !signals ||
      !candidateAssistantIds
    ) {
      return null;
    }
    const warmth = nonnegativeInteger(signals.warmth);
    const familiarity = nonnegativeInteger(signals.familiarity);
    const turns = nonnegativeInteger(signals.turns);
    const version = nonnegativeInteger(candidate.version);
    if (
      warmth === null ||
      familiarity === null ||
      turns === null ||
      version === null
    ) {
      return null;
    }
    return {
      authorityVersion: 1,
      resetSequence: candidate.resetSequence,
      signals: { warmth, familiarity, turns },
      candidateAssistantIds,
      version,
    };
  } catch {
    return null;
  }
}

function nonnegativeInteger(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
    ? value
    : null;
}

function num(v: string | undefined): number {
  const n = v ? Number.parseInt(v, 10) : 0;
  return Number.isFinite(n) ? n : 0;
}
function clampSummary(s: string): string {
  const lines = s.split("\n").map((l) => l.trim()).filter(Boolean);
  const recent = lines.slice(-8).join("\n");
  return recent.length <= 1_200 ? recent : `…${recent.slice(-1_199)}`;
}
