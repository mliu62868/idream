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

const STAGE_ORDER: RelationshipStage[] = ["new", "familiar", "close", "committed"];
const STAGE_THRESHOLDS: Record<RelationshipStage, number> = {
  new: 0,
  familiar: 6,
  close: 20,
  committed: 50,
};

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
}

export async function updateRelationship(
  userId: string,
  characterId: string,
  patch: RelationshipPatch,
): Promise<RelationshipState> {
  return (await updateRelationshipDocument(userId, characterId, patch)).state;
}

/** Apply one generated turn exactly once. BullMQ is at-least-once, so relationship
 * progression must use the same idempotency key as the memory extraction job. */
export async function updateRelationshipOnce(
  userId: string,
  characterId: string,
  turnKey: string,
  patch: RelationshipPatch,
): Promise<{ state: RelationshipState; applied: boolean }> {
  return updateRelationshipDocument(userId, characterId, patch, turnKey);
}

async function updateRelationshipDocument(
  userId: string,
  characterId: string,
  patch: RelationshipPatch,
  turnKey?: string,
): Promise<{ state: RelationshipState; applied: boolean }> {
  const rel = chatFsPaths.relationship(userId, characterId);
  return withFileMutationLock(rel, async () => {
    const document = parseRelationshipDocument(await readWhole(rel));
    if (turnKey && document.appliedTurnKeys.includes(turnKey)) {
      return { state: document.state, applied: false };
    }
    const current = document.state;
    const signals = {
      warmth: current.signals.warmth + (patch.warmth ?? 1),
      familiarity: current.signals.familiarity + (patch.familiarity ?? 1),
      turns: current.signals.turns + 1,
    };
    const score = signals.familiarity + signals.warmth;
    const stage = stageForScore(score);
    const summary = patch.summaryDelta
      ? clampSummary(`${current.summary}\n${patch.summaryDelta}`)
      : current.summary;

    const next: RelationshipState = { stage, signals, summary, version: current.version + 1 };
    const appliedTurnKeys = turnKey
      ? [...document.appliedTurnKeys, turnKey].slice(-256)
      : document.appliedTurnKeys;
    await writeAtomic(rel, renderRelationship(next, appliedTurnKeys));
    return { state: next, applied: true };
  });
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

/** Edit the narrative summary and/or stage (bumps version). Returns the new state. */
export async function setRelationship(
  userId: string,
  characterId: string,
  patch: { summary?: string; stage?: RelationshipStage },
): Promise<RelationshipView> {
  const rel = chatFsPaths.relationship(userId, characterId);
  return withFileMutationLock(rel, async () => {
    const document = parseRelationshipDocument(await readWhole(rel));
    const current = document.state;
    const stage = patch.stage && STAGE_ORDER.includes(patch.stage) ? patch.stage : current.stage;
    const summary = patch.summary != null ? clampSummary(patch.summary) : current.summary;
    const next: RelationshipState = { ...current, stage, summary, version: current.version + 1 };
    await writeAtomic(rel, renderRelationship(next, document.appliedTurnKeys));
    return { characterId, ...next };
  });
}

/** Reset (hard-delete) a relationship — removes the authority file. Idempotent. */
export async function deleteRelationship(userId: string, characterId: string): Promise<void> {
  await deletePrefix(chatFsPaths.relationship(userId, characterId));
}

export function stageForScore(score: number): RelationshipStage {
  let stage: RelationshipStage = "new";
  for (const s of STAGE_ORDER) {
    if (score >= STAGE_THRESHOLDS[s]) stage = s;
  }
  return stage;
}

/** relationship.md = YAML-ish front-matter + a "## Summary" narrative section. */
export function renderRelationship(state: RelationshipState, appliedTurnKeys: string[] = []): string {
  return [
    "---",
    `stage: ${state.stage}`,
    `warmth: ${state.signals.warmth}`,
    `familiarity: ${state.signals.familiarity}`,
    `turns: ${state.signals.turns}`,
    `version: ${state.version}`,
    `applied_turn_keys: ${JSON.stringify(appliedTurnKeys)}`,
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
  };
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
