// SPEC: relationship.md derivation (P1-2, design §5, PRD §7.3). File-layer
// authority (NOT PG). Each turn merges signals + advances stage; narrative summary
// appended. Read-merge-atomic-write so the single chat.memory.extract writer never
// races itself. Used by the model for tone/continuity, not exposed as a game score.
import path from "node:path";
import {
  readWhole,
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
