import { createHmac, timingSafeEqual } from "node:crypto";
import type { AgeVerificationProvider, ProviderResult } from "../types";

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface GoCamAgeVerificationProviderConfig {
  serviceUrl: string;
  apiKey: string;
  webhookSecret: string;
  linkBackUrl?: string;
  callbackUrl?: string;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
}

export class GoCamAgeVerificationProvider implements AgeVerificationProvider {
  private readonly serviceUrl: URL;
  private readonly apiKey: string;
  private readonly webhookSecret: string;
  private readonly linkBackUrl: string | undefined;
  private readonly callbackUrl: string | undefined;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;

  constructor(config: GoCamAgeVerificationProviderConfig) {
    this.serviceUrl = new URL(config.serviceUrl);
    this.apiKey = config.apiKey;
    this.webhookSecret = config.webhookSecret;
    this.linkBackUrl = config.linkBackUrl;
    this.callbackUrl = config.callbackUrl;
    this.timeoutMs = Math.max(250, config.timeoutMs ?? 10_000);
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async createSession(input: Parameters<AgeVerificationProvider["createSession"]>[0]) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(this.endpoint("/sessions"), {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          userId: input.userId,
          jurisdiction: input.jurisdiction,
          linkBackUrl: this.linkBackUrl,
          callbackUrl: this.callbackUrl,
        }),
        signal: controller.signal,
      });
      const json = (await response.json().catch(() => ({}))) as unknown;
      if (!response.ok) return ageFailure("age_session_failed", response.status, json);

      const record = asRecord(json);
      const verificationId =
        stringField(record, "providerVerificationId") ??
        stringField(record, "verificationId") ??
        stringField(record, "sessionId") ??
        stringField(record, "id");
      const url =
        stringField(record, "url") ??
        stringField(record, "verificationUrl") ??
        stringField(record, "redirectUrl");
      if (!verificationId || !url) {
        return {
          ok: false as const,
          error: {
            code: "age_session_failed",
            message: "Go.cam age gateway response missing verification id or url",
            retryable: true,
          },
        };
      }
      return {
        ok: true as const,
        data: {
          provider: "gocam" as const,
          providerVerificationId: verificationId,
          status: normalizeStatus(stringField(record, "status") ?? "pending"),
          url,
        },
      };
    } catch (error) {
      return networkFailure("age_session_failed", error);
    } finally {
      clearTimeout(timeout);
    }
  }

  async parseWebhook(input: Parameters<AgeVerificationProvider["parseWebhook"]>[0]) {
    const signatureResult = this.verifySignature(input.rawBody, input.signature);
    if (!signatureResult.ok) return signatureResult;

    const payload = asRecord(input.payload);
    const providerEventId =
      stringField(payload, "providerEventId") ??
      stringField(payload, "eventId") ??
      stringField(payload, "sessionId") ??
      input.providerEventId;
    return {
      ok: true as const,
      data: {
        providerEventId,
        userId: stringField(payload, "userId") ?? stringField(payload, "userData"),
        providerVerificationId:
          stringField(payload, "providerVerificationId") ??
          stringField(payload, "verificationId") ??
          stringField(payload, "sessionId"),
        status: statusFromPayload(payload),
      },
    };
  }

  private endpoint(defaultPath: string) {
    const url = new URL(this.serviceUrl);
    if (url.pathname === "/" || url.pathname === "") {
      url.pathname = defaultPath;
    }
    return url;
  }

  private verifySignature(
    rawBody: string | undefined,
    signature: string | undefined,
  ): ProviderResult<null> {
    if (!rawBody || !signature) {
      return invalidSignature("Go.cam age webhook signature is required");
    }
    const provided = signature.replace(/^sha256=/, "").trim();
    if (!/^[a-fA-F0-9]{64}$/.test(provided)) {
      return invalidSignature("Go.cam age webhook signature is invalid");
    }

    const expected = createHmac("sha256", this.webhookSecret).update(rawBody).digest("hex");
    const expectedBuffer = Buffer.from(expected, "hex");
    const providedBuffer = Buffer.from(provided, "hex");
    if (
      providedBuffer.length !== expectedBuffer.length ||
      !timingSafeEqual(providedBuffer, expectedBuffer)
    ) {
      return invalidSignature("Go.cam age webhook signature is invalid");
    }
    return { ok: true, data: null };
  }
}

function statusFromPayload(payload: Record<string, unknown>) {
  const direct = stringField(payload, "status") ?? stringField(payload, "state");
  if (direct) return normalizeStatus(direct);
  const stateInt = payload.stateInt;
  if (stateInt === 0 || stateInt === "0") return "verified";
  if (stateInt === 1 || stateInt === "1") return "failed";
  if (stateInt === 2 || stateInt === "2") return "expired";
  return "failed";
}

function normalizeStatus(value: string): "pending" | "verified" | "failed" | "expired" {
  const normalized = value.toLowerCase().replaceAll("_", "-");
  switch (normalized) {
    case "pending":
    case "created":
    case "started":
      return "pending";
    case "verified":
    case "passed":
    case "success":
    case "valid":
    case "approved":
    case "accepted":
      return "verified";
    case "expired":
    case "timeout":
      return "expired";
    default:
      return "failed";
  }
}

function invalidSignature(message: string): ProviderResult<never> {
  return {
    ok: false,
    error: {
      code: "invalid_signature",
      message,
      retryable: false,
    },
  };
}

function ageFailure(
  code: string,
  status: number,
  value: unknown,
): ProviderResult<never> {
  const record = errorRecord(value);
  return {
    ok: false,
    error: {
      code,
      message:
        stringField(record, "message") ??
        stringField(record, "error") ??
        `Age verification request failed with HTTP ${status}`,
      retryable: status === 408 || status === 429 || status >= 500,
    },
  };
}

function networkFailure(code: string, error: unknown): ProviderResult<never> {
  return {
    ok: false,
    error: {
      code,
      message: error instanceof Error ? error.message : "Age verification request failed",
      retryable: true,
    },
  };
}

function errorRecord(value: unknown) {
  const record = asRecord(value);
  const nested = record.error;
  return isRecord(nested) ? nested : record;
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
