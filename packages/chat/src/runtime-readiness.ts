import { mkdir, open, unlink } from "node:fs/promises";
import path from "node:path";
import IORedis from "ioredis";
import { redisConnectionOptions } from "@idream/shared/env";
import { loadAgentRuntimeConfig } from "./agent-runtime/config.js";
import { warmAgentRuntime } from "./agent-runtime/runtime.js";
import { env } from "./env.js";

export interface RuntimeReadinessSnapshot {
  accepting: boolean;
  warmed: boolean;
  fileStore: boolean;
  redis: boolean;
  agentRuntime: boolean;
  fresh: boolean;
  observedAt: string | null;
  reason: string | null;
}

export class RuntimeReadiness {
  private state: Omit<RuntimeReadinessSnapshot, "fresh" | "observedAt"> = {
    accepting: true,
    warmed: false,
    fileStore: false,
    redis: false,
    agentRuntime: false,
    reason: "warming",
  };
  private recover: (() => Promise<void>) | null = null;
  private refreshInFlight: Promise<void> | null = null;
  private observedAtMs: number | null = null;

  constructor(private readonly options: {
    now?: () => number;
    ttlMs?: number;
  } = {}) {}

  snapshot(): RuntimeReadinessSnapshot {
    return {
      ...this.state,
      fresh: this.isFresh(),
      observedAt: this.observedAtMs === null
        ? null
        : new Date(this.observedAtMs).toISOString(),
    };
  }

  canAcceptTurns(): boolean {
    return this.state.accepting && this.state.warmed
      && this.state.fileStore && this.state.redis && this.state.agentRuntime
      && this.isFresh();
  }

  configureFullWarmupRecovery(recover: () => Promise<void>): void {
    this.recover = recover;
  }

  async refreshDependencies(): Promise<void> {
    if (this.canAcceptTurns() || !this.state.accepting || !this.recover) return;
    if (!this.refreshInFlight) {
      this.refreshInFlight = this.recover()
        .catch(() => undefined)
        .finally(() => {
          this.refreshInFlight = null;
        });
    }
    await this.refreshInFlight;
  }

  markReady(): void {
    this.observedAtMs = this.now();
    this.state = {
      accepting: this.state.accepting,
      warmed: true,
      fileStore: true,
      redis: true,
      agentRuntime: true,
      reason: null,
    };
  }

  markFailed(reason: string): void {
    this.observedAtMs = null;
    this.state = { ...this.state, warmed: false, reason };
  }

  stopAccepting(): void {
    this.state = { ...this.state, accepting: false, reason: "shutting_down" };
  }

  private isFresh(): boolean {
    return this.observedAtMs !== null
      && this.now() - this.observedAtMs <= (this.options.ttlMs ?? 5_000);
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }
}

export const runtimeReadiness = new RuntimeReadiness();

/** Admission health proves only the dependencies needed to start one Agent run. */
export async function warmRuntime(input: {
  readiness?: RuntimeReadiness;
  pingRedis?: () => Promise<void>;
  probeAgentRuntime?: () => Promise<void>;
  probeModel?: () => Promise<void>;
} = {}): Promise<void> {
  const readiness = input.readiness ?? runtimeReadiness;
  try {
    await assertWritableFileRoot();
    await (input.pingRedis ?? pingRedis)();
    await (input.probeAgentRuntime ?? warmAgentRuntime)();
    await (input.probeModel ?? probeConfiguredModel)();
    readiness.markReady();
  } catch (error) {
    readiness.markFailed(error instanceof Error ? error.message : "warmup_failed");
    throw error;
  }
}

async function assertWritableFileRoot(): Promise<void> {
  const root = path.resolve(env.CHAT_FS_ROOT);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const file = path.join(root, ".write-probe");
  const handle = await open(file, "a", 0o600);
  try {
    await handle.sync();
  } finally {
    await handle.close();
    await unlink(file).catch(() => undefined);
  }
}

async function pingRedis(): Promise<void> {
  const redis = new IORedis(redisConnectionOptions(env.REDIS_URL));
  try {
    const result = await redis.ping();
    if (result !== "PONG") throw new Error("Redis ping failed");
  } finally {
    await redis.quit().catch(() => redis.disconnect());
  }
}

const MODEL_PROBE_TIMEOUT_MS = 2_000;
const MODEL_PROBE_TTL_MS = 15_000;

/**
 * SPEC: the model endpoint answers `GET <baseUrl>/models` within 2s.
 * INTENT: every other dependency here is local, so a stopped model server left
 * /readyz reporting ok for four days while every Turn failed in 0.5s. This is
 * the cheapest request that proves the server is up; it does not generate.
 * INVARIANT: one outcome is reused for 15s, success or failure, so /readyz
 * polling cannot turn into a request per poll against the model server.
 */
export function createModelEndpointProbe(input: {
  baseUrl: string;
  apiKey: string;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}): () => Promise<void> {
  const request = input.fetch ?? globalThis.fetch;
  const now = input.now ?? Date.now;
  const url = new URL(input.baseUrl.endsWith("/") ? input.baseUrl : `${input.baseUrl}/`);
  url.pathname = `${url.pathname.replace(/\/$/, "")}/models`;
  let cached: { at: number; error: string | null } | null = null;
  return async () => {
    if (!cached || now() - cached.at > MODEL_PROBE_TTL_MS) {
      let error: string | null = null;
      try {
        const response = await request(url, {
          headers: { authorization: `Bearer ${input.apiKey}` },
          signal: AbortSignal.timeout(MODEL_PROBE_TIMEOUT_MS),
        });
        await response.body?.cancel().catch(() => undefined);
        if (!response.ok) error = `model endpoint ${url.origin} returned HTTP ${response.status}`;
      } catch {
        error = `model endpoint ${url.origin} unreachable`;
      }
      cached = { at: now(), error };
    }
    if (cached.error) throw new Error(cached.error);
  };
}

let configuredModelProbe: (() => Promise<void>) | null = null;

function probeConfiguredModel(): Promise<void> {
  if (!configuredModelProbe) {
    const { modelProfile } = loadAgentRuntimeConfig();
    configuredModelProbe = createModelEndpointProbe({ baseUrl: modelProfile.baseUrl, apiKey: modelProfile.apiKey });
  }
  return configuredModelProbe();
}
