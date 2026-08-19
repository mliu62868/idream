import type { CompanionEvent } from "@idream/shared/chat/companion-runtime";

export interface CompanionIgrepAttemptMetric {
  calls: number;
  hit: number;
  empty: number;
  failure: number;
  resultCount: number;
  latencyMs: number[];
}

export interface CompanionOperationalTelemetry {
  sidecar?: {
    instanceId: string;
    startedAt: string;
  };
  igrep?: Partial<Record<"search" | "memory", CompanionIgrepAttemptMetric>>;
}

/** Persist only operational facts; event identities, queries, snippets and paths are discarded. */
export function recordCompanionOperationalEvent(
  telemetry: CompanionOperationalTelemetry,
  event: CompanionEvent,
): void {
  if (event.type === "started") {
    telemetry.sidecar = {
      instanceId: event.instance.id,
      startedAt: event.instance.startedAt,
    };
    return;
  }
  if (event.type !== "igrep_observation") return;
  telemetry.igrep ??= {};
  const metric = telemetry.igrep[event.operation] ?? {
    calls: 0,
    hit: 0,
    empty: 0,
    failure: 0,
    resultCount: 0,
    latencyMs: [],
  };
  metric.calls += 1;
  metric[event.outcome] += 1;
  metric.resultCount += event.resultCount ?? 0;
  metric.latencyMs.push(event.durationMs);
  telemetry.igrep[event.operation] = metric;
}
