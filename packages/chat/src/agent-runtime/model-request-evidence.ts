import type { CompanionModelRequestEvidence, CompanionTerminalCandidate } from "./contracts";

/** Unknown physical usage makes the aggregate unknown, without losing known receipts. */
export function aggregateModelRequestUsage(
  requests: readonly CompanionModelRequestEvidence[],
): CompanionTerminalCandidate["usage"] {
  if (requests.length === 0) return null;
  const total: NonNullable<CompanionTerminalCandidate["usage"]> = {
    promptTokens: 0, completionTokens: 0, reasoningTokens: 0,
  };
  for (const { usage } of requests) {
    if (!usage) return null;
    total.promptTokens += usage.inputTokens + (usage.cacheReadTokens ?? 0);
    total.completionTokens += usage.outputTokens;
    total.reasoningTokens = total.reasoningTokens === null || usage.reasoningTokens === undefined
      ? null : total.reasoningTokens + usage.reasoningTokens;
  }
  return total;
}
