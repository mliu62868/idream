export type ModerationStatus = "passed" | "flagged" | "blocked";

export type ModerationProviderResult<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      error: { code: string; message: string; retryable: boolean };
    };

export interface SafetyGatewayModerationProviderConfig {
  serviceUrl: string;
  apiKey?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface ModerationCheckInput {
  targetType: "text" | "image" | "video";
  content: string;
}

export interface ModerationDecision {
  status: ModerationStatus;
  policyCode?: string;
  confidence: number;
}

export class SafetyGatewayModerationProvider {
  private readonly endpoint: URL;
  private readonly apiKey: string | undefined;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(config: SafetyGatewayModerationProviderConfig) {
    this.endpoint = moderationEndpoint(config.serviceUrl);
    this.apiKey = config.apiKey;
    this.timeoutMs = Math.max(250, config.timeoutMs ?? 5_000);
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async check(
    input: ModerationCheckInput,
  ): Promise<ModerationProviderResult<ModerationDecision>> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers: Record<string, string> = {
        "content-type": "application/json",
      };
      if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;

      const response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({
          targetType: input.targetType,
          target_type: input.targetType,
          content: input.content,
        }),
        signal: controller.signal,
      });
      const json = (await response.json().catch(() => ({}))) as unknown;
      if (!response.ok) return moderationFailure(response.status, json);
      return parseModerationDecision(json);
    } catch (error) {
      return networkFailure(error);
    } finally {
      clearTimeout(timeout);
    }
  }
}

function moderationEndpoint(serviceUrl: string) {
  const url = new URL(serviceUrl);
  if (url.pathname === "/" || url.pathname === "") {
    return new URL("/moderation/check", url);
  }
  return url;
}

function parseModerationDecision(
  value: unknown,
): ModerationProviderResult<ModerationDecision> {
  const root = asRecord(value);
  const record = nestedDecisionRecord(root);
  const openAiDecision = decisionFromOpenAiResult(root);
  const status = openAiDecision?.status ?? statusFromRecord(record);
  if (!status) {
    return {
      ok: false,
      error: {
        code: "invalid_moderation_response",
        message: "Moderation response did not include a supported decision",
        retryable: true,
      },
    };
  }

  return {
    ok: true,
    data: {
      status,
      policyCode: policyCodeFromRecord(record) ?? openAiDecision?.policyCode,
      confidence: confidenceFromRecord(record) ?? openAiDecision?.confidence ?? defaultConfidence(status),
    },
  };
}

function nestedDecisionRecord(root: Record<string, unknown>) {
  const result = root.result;
  if (isRecord(result)) return result;
  const data = root.data;
  if (isRecord(data)) return data;
  return root;
}

function decisionFromOpenAiResult(root: Record<string, unknown>) {
  const results = root.results;
  if (!Array.isArray(results)) return undefined;
  const first = results[0];
  if (!isRecord(first)) return undefined;
  const flagged = first.flagged === true;
  if (!flagged) {
    return {
      status: "passed" as const,
      confidence: confidenceFromRecord(first) ?? 0.5,
    };
  }
  return {
    status: "flagged" as const,
    policyCode: policyCodeFromRecord(first),
    confidence: confidenceFromRecord(first) ?? 0.9,
  };
}

function statusFromRecord(record: Record<string, unknown>) {
  const direct =
    normalizeStatus(stringField(record, "status")) ??
    normalizeStatus(stringField(record, "decision")) ??
    normalizeStatus(stringField(record, "action"));
  if (direct) return direct;
  if (record.blocked === true) return "blocked";
  if (record.flagged === true) return "flagged";
  if (record.allowed === true || record.passed === true) return "passed";
  return undefined;
}

function normalizeStatus(value: string | undefined): ModerationStatus | undefined {
  const normalized = value?.toLowerCase().replaceAll("_", "-");
  switch (normalized) {
    case "passed":
    case "pass":
    case "allow":
    case "allowed":
    case "approved":
    case "safe":
      return "passed";
    case "flagged":
    case "flag":
    case "review":
    case "manual-review":
    case "needs-review":
      return "flagged";
    case "blocked":
    case "block":
    case "deny":
    case "denied":
    case "reject":
    case "rejected":
    case "unsafe":
      return "blocked";
    default:
      return undefined;
  }
}

function policyCodeFromRecord(record: Record<string, unknown>) {
  return (
    stringField(record, "policyCode") ??
    stringField(record, "policy_code") ??
    stringField(record, "code") ??
    stringField(record, "category") ??
    stringField(record, "reason") ??
    policyCodeFromCategories(record.categories)
  );
}

function policyCodeFromCategories(value: unknown) {
  if (Array.isArray(value)) {
    const first = value.find((item) => typeof item === "string" && item.length > 0);
    return first as string | undefined;
  }
  if (!isRecord(value)) return undefined;
  const hit = Object.entries(value).find(([, enabled]) => enabled === true);
  return hit?.[0];
}

function confidenceFromRecord(record: Record<string, unknown>) {
  return (
    numberField(record, "confidence") ??
    numberField(record, "score") ??
    confidenceFromCategories(record.category_scores) ??
    confidenceFromCategories(record.categoryScores)
  );
}

function confidenceFromCategories(value: unknown) {
  if (!isRecord(value)) return undefined;
  const scores = Object.values(value).filter((item): item is number => typeof item === "number");
  if (scores.length === 0) return undefined;
  return clamp(Math.max(...scores));
}

function defaultConfidence(status: ModerationStatus) {
  return status === "passed" ? 0.5 : 0.9;
}

function moderationFailure(
  status: number,
  value: unknown,
): ModerationProviderResult<never> {
  const record = errorRecord(value);
  return {
    ok: false,
    error: {
      code: stringField(record, "code") ?? statusToCode(status),
      message:
        stringField(record, "message") ??
        stringField(record, "error") ??
        `Moderation request failed with HTTP ${status}`,
      retryable: status === 408 || status === 429 || status >= 500,
    },
  };
}

function networkFailure(error: unknown): ModerationProviderResult<never> {
  const timedOut = error instanceof Error && error.name === "AbortError";
  return {
    ok: false,
    error: {
      code: timedOut ? "moderation_timeout" : "moderation_network_error",
      message: timedOut
        ? "Moderation request timed out"
        : error instanceof Error
          ? error.message
          : "Moderation request failed",
      retryable: true,
    },
  };
}

function errorRecord(value: unknown) {
  const record = asRecord(value);
  const nested = record.error;
  return isRecord(nested) ? nested : record;
}

function statusToCode(status: number) {
  if (status === 400) return "invalid_moderation_request";
  if (status === 401 || status === 403) return "moderation_auth_failed";
  if (status === 408) return "moderation_timeout";
  if (status === 429) return "moderation_rate_limited";
  if (status >= 500) return "moderation_unavailable";
  return "moderation_request_failed";
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberField(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? clamp(value) : undefined;
}

function clamp(value: number) {
  return Math.max(0, Math.min(1, value));
}
