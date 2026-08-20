export type CompanionRuntimeName = "dsh";
export type CompanionMemoryBackend = "igrep-dsh";

export interface CompanionRuntimeConfig {
  runtime: CompanionRuntimeName;
  memoryBackend: CompanionMemoryBackend;
  sidecarUrl: string;
  sidecarToken: string;
  normalProfile: string;
  privateProfile: string;
  deadlineMs: number;
}

export interface CompanionAttemptRuntime {
  runtime: CompanionRuntimeName;
  memoryBackend: CompanionMemoryBackend;
  profile: string;
  private: boolean;
  sidecarUrl: string;
  deadlineMs: number;
}

export type CompanionRuntimePin = CompanionAttemptRuntime;

const NORMAL_PROFILE = "idream-companion-memory";
const PRIVATE_PROFILE = "idream-companion-private";

/**
 * INVARIANT: Phase 6 has one execution and generic-memory authority. A missing
 * sidecar credential must stop admission; there is no native fallback.
 */
export function resolveCompanionRuntimeConfig(
  source: Readonly<Record<string, string | undefined>>,
): CompanionRuntimeConfig {
  const sidecarToken = source.DSH_AGENT_TOKEN?.trim() ?? "";
  if (!sidecarToken) throw new Error("Missing required env var DSH_AGENT_TOKEN");
  return {
    runtime: "dsh",
    memoryBackend: "igrep-dsh",
    sidecarUrl: canonicalCompanionSidecarUrl(
      source.DSH_AGENT_URL ?? "http://127.0.0.1:3101",
      "DSH_AGENT_URL",
    ),
    sidecarToken,
    normalProfile: canonicalProfile(
      source.DSH_PROFILE_NORMAL,
      NORMAL_PROFILE,
      "DSH_PROFILE_NORMAL",
    ),
    privateProfile: canonicalProfile(
      source.DSH_PROFILE_PRIVATE,
      PRIVATE_PROFILE,
      "DSH_PROFILE_PRIVATE",
    ),
    deadlineMs: parsePositiveInteger(
      source.DSH_AGENT_DEADLINE_MS,
      5 * 60_000,
      "DSH_AGENT_DEADLINE_MS",
    ),
  };
}

/** Pin once before the attempt is recorded; never re-read process.env mid-turn. */
export function selectCompanionRuntimeForAttempt(input: {
  config: CompanionRuntimeConfig;
  memoryAuthority: "enabled" | "disabled";
}): CompanionAttemptRuntime {
  const isPrivate = input.memoryAuthority === "disabled";
  return {
    runtime: "dsh",
    memoryBackend: "igrep-dsh",
    profile: isPrivate ? input.config.privateProfile : input.config.normalProfile,
    private: isPrivate,
    sidecarUrl: input.config.sidecarUrl,
    deadlineMs: input.config.deadlineMs,
  };
}

/** Existing DSH attempts keep their recorded profile; no historical runtime may resume. */
export function pinCompanionRuntimeForAttempt(input: {
  config: CompanionRuntimeConfig;
  memoryAuthority: "enabled" | "disabled";
  priorPin?: unknown;
}): CompanionAttemptRuntime {
  if (input.priorPin === undefined || input.priorPin === null) {
    return selectCompanionRuntimeForAttempt(input);
  }
  return parsePriorPin(input.priorPin, input);
}

function parsePriorPin(
  value: unknown,
  input: {
    config: CompanionRuntimeConfig;
    memoryAuthority: "enabled" | "disabled";
  },
): CompanionRuntimePin {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("attempt companion runtime pin is invalid");
  }
  const candidate = value as Record<string, unknown>;
  const isPrivate = input.memoryAuthority === "disabled";
  if (
    candidate.runtime !== "dsh" ||
    candidate.memoryBackend !== "igrep-dsh" ||
    candidate.private !== isPrivate ||
    candidate.profile !== (isPrivate ? PRIVATE_PROFILE : NORMAL_PROFILE)
  ) {
    throw new Error("attempt companion runtime pin is invalid");
  }
  const sidecarUrl = typeof candidate.sidecarUrl === "string" && candidate.sidecarUrl
    ? canonicalCompanionSidecarUrl(
        candidate.sidecarUrl,
        "attempt companion runtime sidecar URL",
      )
    : input.config.sidecarUrl;
  const deadlineMs = typeof candidate.deadlineMs === "number" &&
      Number.isSafeInteger(candidate.deadlineMs) && candidate.deadlineMs > 0
    ? candidate.deadlineMs
    : input.config.deadlineMs;
  return {
    runtime: "dsh",
    memoryBackend: "igrep-dsh",
    profile: isPrivate ? PRIVATE_PROFILE : NORMAL_PROFILE,
    private: isPrivate,
    sidecarUrl,
    deadlineMs,
  };
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
