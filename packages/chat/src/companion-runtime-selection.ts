export type CompanionRuntimeName = "native" | "dsh";
export type CompanionMemoryBackend = "legacy" | "igrep-dsh";

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

export type CompanionRuntimePin = Pick<
  CompanionAttemptRuntime,
  "runtime" | "memoryBackend" | "profile" | "private"
>;

const RUNTIMES = new Set<CompanionRuntimeName>(["native", "dsh"]);
const MEMORY_BACKENDS = new Set<CompanionMemoryBackend>([
  "legacy",
  "igrep-dsh",
]);

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

  const sidecarToken = source.DSH_AGENT_TOKEN?.trim() ?? "";
  if (runtime === "dsh" && !sidecarToken) {
    throw new Error("Missing required env var DSH_AGENT_TOKEN");
  }
  const sidecarUrl = source.DSH_AGENT_URL ?? "http://127.0.0.1:3101";
  const parsedUrl = new URL(sidecarUrl);
  if (!new Set(["http:", "https:"]).has(parsedUrl.protocol)) {
    throw new Error("DSH_AGENT_URL must use http or https");
  }
  const deadlineMs = parsePositiveInteger(
    source.DSH_AGENT_DEADLINE_MS,
    5 * 60_000,
    "DSH_AGENT_DEADLINE_MS",
  );

  return {
    runtime: runtime as CompanionRuntimeName,
    memoryBackend: memoryBackend as CompanionMemoryBackend,
    sidecarUrl: parsedUrl.toString().replace(/\/$/, ""),
    sidecarToken,
    normalProfile: nonEmpty(
      source.DSH_PROFILE_NORMAL,
      "idream-companion-memory",
      "DSH_PROFILE_NORMAL",
    ),
    privateProfile: nonEmpty(
      source.DSH_PROFILE_PRIVATE,
      "idream-companion-private",
      "DSH_PROFILE_PRIVATE",
    ),
    deadlineMs,
  };
}

/** Pin once before the attempt is recorded; never re-read process.env mid-turn. */
export function selectCompanionRuntimeForAttempt(input: {
  config: CompanionRuntimeConfig;
  memoryAuthority: "enabled" | "disabled";
}): CompanionAttemptRuntime {
  const isPrivate = input.memoryAuthority === "disabled";
  return {
    runtime: input.config.runtime,
    memoryBackend: input.config.memoryBackend,
    profile:
      input.config.runtime === "dsh"
        ? isPrivate
          ? input.config.privateProfile
          : input.config.normalProfile
        : "native",
    private: isPrivate,
    sidecarUrl: input.config.sidecarUrl,
    deadlineMs: input.config.deadlineMs,
  };
}

/** A retried attempt may reuse its pin, but can never silently change it. */
export function pinCompanionRuntimeForAttempt(input: {
  config: CompanionRuntimeConfig;
  memoryAuthority: "enabled" | "disabled";
  priorPin?: unknown;
}): CompanionAttemptRuntime {
  const selected = selectCompanionRuntimeForAttempt(input);
  if (input.priorPin === undefined || input.priorPin === null) return selected;
  const expected: CompanionRuntimePin = {
    runtime: selected.runtime,
    memoryBackend: selected.memoryBackend,
    profile: selected.profile,
    private: selected.private,
  };
  if (!sameRuntimePin(input.priorPin, expected)) {
    throw new Error(
      "attempt pinned companion runtime differs from current deployment routing",
    );
  }
  return selected;
}

function sameRuntimePin(value: unknown, expected: CompanionRuntimePin): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return candidate.runtime === expected.runtime &&
    candidate.memoryBackend === expected.memoryBackend &&
    candidate.profile === expected.profile &&
    candidate.private === expected.private;
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

function nonEmpty(
  value: string | undefined,
  fallback: string,
  name: string,
): string {
  const resolved = value?.trim() || fallback;
  if (!resolved) throw new Error(`${name} must not be empty`);
  return resolved;
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
