import { mkdir, open, unlink } from "node:fs/promises";
import path from "node:path";
import IORedis from "ioredis";
import { redisConnectionOptions } from "@idream/shared/env";
import { probeCompanionSidecar } from "./companion-sidecar-readiness.js";
import { env } from "./env.js";

export interface RuntimeReadinessSnapshot {
  accepting: boolean;
  warmed: boolean;
  fileStore: boolean;
  redis: boolean;
  companion: boolean;
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
    companion: false,
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
      && this.state.fileStore && this.state.redis && this.state.companion
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
      companion: true,
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

/** Chat readiness now proves exactly three dependencies: files, Redis SSE, DSH. */
export async function warmRuntime(input: {
  readiness?: RuntimeReadiness;
  pingRedis?: () => Promise<void>;
  probeSidecar?: () => Promise<void>;
} = {}): Promise<void> {
  const readiness = input.readiness ?? runtimeReadiness;
  try {
    await assertWritableFileRoot();
    await (input.pingRedis ?? pingRedis)();
    await (input.probeSidecar ?? probeSidecar)();
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

async function probeSidecar(): Promise<void> {
  const config = env.COMPANION_RUNTIME_CONFIG;
  await probeCompanionSidecar({
    baseUrl: config.sidecarUrl,
    token: config.sidecarToken,
    expectedProvider: env.CHAT_MODEL_PROVIDER,
    expectedBaseUrl: env.CHAT_MODEL_BASE_URL,
    expectedModel: env.CHAT_MODEL_NAME,
  });
}
