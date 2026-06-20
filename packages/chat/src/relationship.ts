// SPEC: relationship.md derivation (P1-2, design §5, PRD §7.3). File-layer
// authority (NOT PG). Each turn merges signals + advances stage; narrative summary
// appended. Read-merge-atomic-write so the single chat.memory.extract writer never
// races itself. Used by the model for tone/continuity, not exposed as a game score.
import { readWhole, writeAtomic, chatFsPaths } from "./chat-fs.js";

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

export async function updateRelationship(
  userId: string,
  characterId: string,
  patch: RelationshipPatch,
): Promise<RelationshipState> {
  const current = parseRelationship(await readWhole(chatFsPaths.relationship(userId, characterId)));
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
  await writeAtomic(chatFsPaths.relationship(userId, characterId), renderRelationship(next));
  return next;
}

export function stageForScore(score: number): RelationshipStage {
  let stage: RelationshipStage = "new";
  for (const s of STAGE_ORDER) {
    if (score >= STAGE_THRESHOLDS[s]) stage = s;
  }
  return stage;
}

/** relationship.md = YAML-ish front-matter + a "## Summary" narrative section. */
export function renderRelationship(state: RelationshipState): string {
  return [
    "---",
    `stage: ${state.stage}`,
    `warmth: ${state.signals.warmth}`,
    `familiarity: ${state.signals.familiarity}`,
    `turns: ${state.signals.turns}`,
    `version: ${state.version}`,
    "---",
    "",
    "## Summary",
    state.summary.trim(),
    "",
  ].join("\n");
}

export function parseRelationship(raw: string | null): RelationshipState {
  if (!raw) return { ...EMPTY, signals: { ...EMPTY.signals } };
  const fm = raw.match(/^---\n([\s\S]*?)\n---/);
  const get = (key: string) => fm?.[1].match(new RegExp(`^${key}:\\s*(.+)$`, "m"))?.[1]?.trim();
  const summary = raw.split("## Summary")[1]?.trim() ?? "";
  const stage = (get("stage") as RelationshipStage) ?? "new";
  return {
    stage: STAGE_ORDER.includes(stage) ? stage : "new",
    signals: {
      warmth: num(get("warmth")),
      familiarity: num(get("familiarity")),
      turns: num(get("turns")),
    },
    summary,
    version: num(get("version")),
  };
}

function num(v: string | undefined): number {
  const n = v ? Number.parseInt(v, 10) : 0;
  return Number.isFinite(n) ? n : 0;
}
function clampSummary(s: string): string {
  const lines = s.split("\n").map((l) => l.trim()).filter(Boolean);
  return lines.slice(-8).join("\n");
}
