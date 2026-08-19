import { createHash } from "node:crypto";

export type CompanionRuntimeName = "native" | "dsh";
export type CompanionMemoryBackend = "legacy" | "igrep-dsh";

export type CompanionRuntimeAssignmentReason =
  | "disabled"
  | "allowlist"
  | "threshold"
  | "outside_cohort"
  | "prior_attempt";

export interface CompanionRuntimeAssignment {
  policyVersion: 1;
  cohortKeyHash: string;
  bucketBps: number | null;
  thresholdBps: number;
  reason: CompanionRuntimeAssignmentReason;
}

export interface CompanionRuntimeConfig {
  runtime: CompanionRuntimeName;
  memoryBackend: CompanionMemoryBackend;
  sidecarUrl: string;
  sidecarToken: string;
  normalProfile: string;
  privateProfile: string;
  deadlineMs: number;
  dshRollout: {
    salt: string;
    thresholdBps: number;
    allowlist: readonly string[];
  };
  dshShadow: {
    enabled: boolean;
  };
}

export interface CompanionAttemptRuntime {
  runtime: CompanionRuntimeName;
  memoryBackend: CompanionMemoryBackend;
  profile: string;
  private: boolean;
  sidecarUrl: string;
  deadlineMs: number;
  assignment: CompanionRuntimeAssignment;
}

export type CompanionRuntimePin = Pick<
  CompanionAttemptRuntime,
  | "runtime"
  | "memoryBackend"
  | "profile"
  | "private"
  | "sidecarUrl"
  | "deadlineMs"
  | "assignment"
>;

const RUNTIMES = new Set<CompanionRuntimeName>(["native", "dsh"]);
const MEMORY_BACKENDS = new Set<CompanionMemoryBackend>([
  "legacy",
  "igrep-dsh",
]);
const NORMAL_PROFILE = "idream-companion-memory";
const PRIVATE_PROFILE = "idream-companion-private";

/**
 * INVARIANT: runtime and memory authority are one deployment decision. A typo
 * must stop admission instead of silently routing a durable turn elsewhere.
 */
export function resolveCompanionRuntimeConfig(
  source: Readonly<Record<string, string | undefined>>,
): CompanionRuntimeConfig {
  const runtime = source.CHAT_COMPANION_RUNTIME ?? "native";
  if (!RUNTIMES.has(runtime as CompanionRuntimeName)) {
    throw new Error(`Invalid CHAT_COMPANION_RUNTIME=${runtime}`);
  }
  const memoryBackend = source.CHAT_MEMORY_BACKEND ?? "legacy";
  if (!MEMORY_BACKENDS.has(memoryBackend as CompanionMemoryBackend)) {
    throw new Error(`Invalid CHAT_MEMORY_BACKEND=${memoryBackend}`);
  }
  if (runtime === "dsh" && memoryBackend !== "igrep-dsh") {
    throw new Error(
      "CHAT_COMPANION_RUNTIME=dsh requires CHAT_MEMORY_BACKEND=igrep-dsh",
    );
  }
  if (runtime === "native" && memoryBackend !== "legacy") {
    throw new Error(
      "CHAT_MEMORY_BACKEND=igrep-dsh requires CHAT_COMPANION_RUNTIME=dsh",
    );
  }

  const thresholdBps = parseIntegerInRange(
    source.CHAT_COMPANION_DSH_ROLLOUT_BPS,
    0,
    0,
    10_000,
    "CHAT_COMPANION_DSH_ROLLOUT_BPS",
  );
  const rolloutAllowlist = parseRelationshipAllowlist(
    source.CHAT_COMPANION_DSH_ROLLOUT_ALLOWLIST,
  );
  const rolloutSalt = source.CHAT_COMPANION_DSH_ROLLOUT_SALT?.trim() ?? "";
  const shadowEnabled = parseBoolean(
    source.CHAT_COMPANION_DSH_SHADOW_ENABLED,
    false,
    "CHAT_COMPANION_DSH_SHADOW_ENABLED",
  );
  if (runtime === "native" && (thresholdBps !== 0 || rolloutAllowlist.length !== 0)) {
    throw new Error(
      "DSH rollout must be empty while CHAT_COMPANION_RUNTIME=native",
    );
  }
  if (runtime === "dsh" && shadowEnabled) {
    throw new Error("DSH shadow requires CHAT_COMPANION_RUNTIME=native");
  }
  const sidecarToken = source.DSH_AGENT_TOKEN?.trim() ?? "";
  if ((runtime === "dsh" || shadowEnabled) && !sidecarToken) {
    throw new Error("Missing required env var DSH_AGENT_TOKEN");
  }
  if (runtime === "dsh" && !rolloutSalt) {
    throw new Error(
      "Missing required env var CHAT_COMPANION_DSH_ROLLOUT_SALT",
    );
  }
  const sidecarUrl = canonicalCompanionSidecarUrl(
    source.DSH_AGENT_URL ?? "http://127.0.0.1:3101",
    "DSH_AGENT_URL",
  );
  const deadlineMs = parsePositiveInteger(
    source.DSH_AGENT_DEADLINE_MS,
    5 * 60_000,
    "DSH_AGENT_DEADLINE_MS",
  );

  return {
    runtime: runtime as CompanionRuntimeName,
    memoryBackend: memoryBackend as CompanionMemoryBackend,
    sidecarUrl,
    sidecarToken,
    normalProfile: canonicalProfile(source.DSH_PROFILE_NORMAL, NORMAL_PROFILE, "DSH_PROFILE_NORMAL"),
    privateProfile: canonicalProfile(source.DSH_PROFILE_PRIVATE, PRIVATE_PROFILE, "DSH_PROFILE_PRIVATE"),
    deadlineMs,
    dshRollout: {
      salt: rolloutSalt,
      thresholdBps,
      allowlist: rolloutAllowlist,
    },
    dshShadow: { enabled: shadowEnabled },
  };
}

/** Pin once before the attempt is recorded; never re-read process.env mid-turn. */
export function selectCompanionRuntimeForAttempt(input: {
  config: CompanionRuntimeConfig;
  memoryAuthority: "enabled" | "disabled";
  userId: string;
  characterId: string;
}): CompanionAttemptRuntime {
  const isPrivate = input.memoryAuthority === "disabled";
  const assignment = assignRelationshipCohort(input);
  const runtime = assignment.reason === "allowlist" || assignment.reason === "threshold"
    ? "dsh"
    : "native";
  return {
    runtime,
    memoryBackend: runtime === "dsh" ? "igrep-dsh" : "legacy",
    profile:
      runtime === "dsh"
        ? isPrivate
          ? input.config.privateProfile
          : input.config.normalProfile
        : "native",
    private: isPrivate,
    sidecarUrl: input.config.sidecarUrl,
    deadlineMs: input.config.deadlineMs,
    assignment,
  };
}

/** Existing attempts keep their recorded route; rollout changes affect only new attempts. */
export function pinCompanionRuntimeForAttempt(input: {
  config: CompanionRuntimeConfig;
  memoryAuthority: "enabled" | "disabled";
  userId: string;
  characterId: string;
  priorPin?: unknown;
}): CompanionAttemptRuntime {
  if (input.priorPin === undefined || input.priorPin === null) {
    return selectCompanionRuntimeForAttempt(input);
  }
  const prior = parsePriorPin(input.priorPin, input);
  return prior;
}

function assignRelationshipCohort(input: {
  config: CompanionRuntimeConfig;
  userId: string;
  characterId: string;
}): CompanionRuntimeAssignment {
  if (input.config.runtime === "native") {
    return {
      policyVersion: 1,
      cohortKeyHash: relationshipDigest("native-disabled", input.userId, input.characterId),
      bucketBps: null,
      thresholdBps: 0,
      reason: "disabled",
    };
  }
  const cohortKeyHash = relationshipDigest(
    input.config.dshRollout.salt,
    input.userId,
    input.characterId,
  );
  const bucketBps = Number.parseInt(cohortKeyHash.slice(0, 8), 16) % 10_000;
  const allowlistKey = `${input.userId}:${input.characterId}`;
  const reason: CompanionRuntimeAssignmentReason = input.config.dshRollout.allowlist.includes(allowlistKey)
    ? "allowlist"
    : bucketBps < input.config.dshRollout.thresholdBps
      ? "threshold"
      : "outside_cohort";
  return {
    policyVersion: 1,
    cohortKeyHash,
    bucketBps,
    thresholdBps: input.config.dshRollout.thresholdBps,
    reason,
  };
}

function parsePriorPin(
  value: unknown,
  input: {
    config: CompanionRuntimeConfig;
    memoryAuthority: "enabled" | "disabled";
    userId: string;
    characterId: string;
  },
): CompanionRuntimePin {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("attempt companion runtime pin is invalid");
  }
  const candidate = value as Record<string, unknown>;
  const isPrivate = input.memoryAuthority === "disabled";
  if (candidate.private !== isPrivate || typeof candidate.profile !== "string") {
    throw new Error("attempt companion runtime pin is invalid");
  }
  if (
    !(
      (candidate.runtime === "native" &&
        candidate.memoryBackend === "legacy" &&
        candidate.profile === "native") ||
      (candidate.runtime === "dsh" &&
        candidate.memoryBackend === "igrep-dsh" &&
        candidate.profile === (isPrivate ? PRIVATE_PROFILE : NORMAL_PROFILE))
    )
  ) {
    throw new Error("attempt companion runtime pin is invalid");
  }
  const sidecarUrl = typeof candidate.sidecarUrl === "string" && candidate.sidecarUrl
    ? canonicalSidecarUrl(candidate.sidecarUrl)
    : input.config.sidecarUrl;
  const deadlineMs = typeof candidate.deadlineMs === "number"
    && Number.isSafeInteger(candidate.deadlineMs) && candidate.deadlineMs > 0
    ? candidate.deadlineMs
    : input.config.deadlineMs;
  return {
    runtime: candidate.runtime,
    memoryBackend: candidate.memoryBackend,
    profile: candidate.profile,
    private: isPrivate,
    sidecarUrl,
    deadlineMs,
    assignment: candidate.assignment === undefined
      ? {
          policyVersion: 1,
          cohortKeyHash: relationshipDigest(
            input.config.dshRollout.salt || "prior-attempt",
            input.userId,
            input.characterId,
          ),
          bucketBps: null,
          thresholdBps: 0,
          reason: "prior_attempt",
        }
      : parsePriorAssignment(candidate.assignment),
  };
}

function parsePriorAssignment(value: unknown): CompanionRuntimeAssignment {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("attempt companion runtime assignment is invalid");
  }
  const candidate = value as Record<string, unknown>;
  const reasons = new Set<CompanionRuntimeAssignmentReason>([
    "disabled",
    "allowlist",
    "threshold",
    "outside_cohort",
    "prior_attempt",
  ]);
  if (
    candidate.policyVersion !== 1 ||
    typeof candidate.cohortKeyHash !== "string" ||
    !candidate.cohortKeyHash ||
    !(candidate.bucketBps === null || isIntegerInRange(candidate.bucketBps, 0, 9_999)) ||
    !isIntegerInRange(candidate.thresholdBps, 0, 10_000) ||
    !reasons.has(candidate.reason as CompanionRuntimeAssignmentReason)
  ) {
    throw new Error("attempt companion runtime assignment is invalid");
  }
  return candidate as unknown as CompanionRuntimeAssignment;
}

/** Legacy extract/retrieval must stand down only for an explicit complete pin. */
export function genericMemoryOwnedByCompanionRuntime(
  runtimeTrace: unknown,
): boolean {
  if (!runtimeTrace || typeof runtimeTrace !== "object" || Array.isArray(runtimeTrace)) {
    return false;
  }
  const pin = (runtimeTrace as Record<string, unknown>).companionRuntime;
  if (!pin || typeof pin !== "object" || Array.isArray(pin)) return false;
  const record = pin as Record<string, unknown>;
  return record.runtime === "dsh" &&
    record.memoryBackend === "igrep-dsh" &&
    typeof record.profile === "string" &&
    typeof record.private === "boolean";
}

function canonicalProfile(
  value: string | undefined,
  expected: string,
  name: string,
): string {
  const resolved = value?.trim() || expected;
  if (resolved !== expected) throw new Error(`${name} must be ${expected}`);
  return expected;
}

function canonicalSidecarUrl(value: string): string {
  return canonicalCompanionSidecarUrl(
    value,
    "attempt companion runtime sidecar URL",
  );
}

/** Bearer-authenticated companion RPC is intentionally local-only. */
export function canonicalCompanionSidecarUrl(value: string, name: string): string {
  const parsed = new URL(value);
  if (!new Set(["http:", "https:"]).has(parsed.protocol)) {
    throw new Error(`${name} must use http or https`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`${name} must not contain credentials`);
  }
  if (parsed.search || parsed.hash) {
    throw new Error(`${name} must not contain query or fragment`);
  }
  if (!new Set(["127.0.0.1", "[::1]", "localhost"]).has(parsed.hostname.toLowerCase())) {
    throw new Error(`${name} must use a loopback host`);
  }
  return parsed.toString().replace(/\/$/, "");
}

function parsePositiveInteger(
  value: string | undefined,
  fallback: number,
  name: string,
): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function parseIntegerInRange(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
  name: string,
): number {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) {
    throw new Error(`${name} must be an integer in ${min}..${max}`);
  }
  const parsed = Number(value);
  if (!isIntegerInRange(parsed, min, max)) {
    throw new Error(`${name} must be an integer in ${min}..${max}`);
  }
  return parsed;
}

function parseBoolean(
  value: string | undefined,
  fallback: boolean,
  name: string,
): boolean {
  if (value === undefined) return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be true or false`);
}

function isIntegerInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= min &&
    value <= max;
}

function parseRelationshipAllowlist(value: string | undefined): readonly string[] {
  if (value === undefined || value.trim() === "") return [];
  const entries = value.split(",").map((entry) => entry.trim());
  if (entries.some((entry) => !/^[^:,\s]+:[^:,\s]+$/.test(entry))) {
    throw new Error(
      "CHAT_COMPANION_DSH_ROLLOUT_ALLOWLIST must contain comma-separated userId:characterId pairs",
    );
  }
  return [...new Set(entries)].sort();
}

function relationshipDigest(salt: string, userId: string, characterId: string): string {
  return createHash("sha256")
    .update([salt, userId, characterId].join("\0"))
    .digest("hex");
}
