// SPEC: DSH owns model execution. Chat retains only its terminal input/output
// moderation boundary; no model adapter or second execution authority lives here.
import { SafetyGatewayModerationProvider } from "@idream/shared";
import { env } from "./env.js";

export interface ModerationResult {
  status: "passed" | "flagged" | "blocked";
  policyCode?: string;
  confidence: number;
}

export interface ModerationProvider {
  check(input: { targetType: "text"; content: string }): Promise<ModerationResult>;
}

const BLOCKED_TERMS = ["underage", "minor", "csam"];

class MockModerationProvider implements ModerationProvider {
  async check(input: { targetType: "text"; content: string }): Promise<ModerationResult> {
    const lowered = input.content.toLowerCase();
    const term = BLOCKED_TERMS.find((candidate) => lowered.includes(candidate));
    if (term) {
      return {
        status: "blocked",
        policyCode: term === "csam" ? "potential_underage_content" : "age_under_18",
        confidence: 0.99,
      };
    }
    return { status: "passed", confidence: 0.5 };
  }
}

class SafetyGatewayChatModerationProvider implements ModerationProvider {
  private readonly gateway: SafetyGatewayModerationProvider;

  constructor(config: { serviceUrl: string; apiKey: string; timeoutMs: number }) {
    this.gateway = new SafetyGatewayModerationProvider(config);
  }

  async check(input: { targetType: "text"; content: string }): Promise<ModerationResult> {
    const result = await this.gateway.check(input);
    if (result.ok) return result.data;
    return {
      status: "blocked",
      policyCode: result.error.code,
      confidence: 1,
    };
  }
}

export interface ChatProviders {
  moderation: ModerationProvider;
}

function requireProviderEnv(
  name: string,
  value: string | undefined,
  providerName: string,
  provider: string,
): string {
  if (!value) throw new Error(`${name} is required when ${providerName}=${provider}`);
  return value;
}

function createModerationProvider(): ModerationProvider {
  switch (env.MODERATION_PROVIDER) {
    case "mock":
      return new MockModerationProvider();
    case "safety-gateway":
      return new SafetyGatewayChatModerationProvider({
        serviceUrl: requireProviderEnv(
          "MODERATION_SERVICE_URL",
          env.MODERATION_SERVICE_URL,
          "MODERATION_PROVIDER",
          env.MODERATION_PROVIDER,
        ),
        apiKey: requireProviderEnv(
          "MODERATION_API_KEY",
          env.MODERATION_API_KEY,
          "MODERATION_PROVIDER",
          env.MODERATION_PROVIDER,
        ),
        timeoutMs: env.MODERATION_TIMEOUT_MS,
      });
    default:
      throw new Error(
        `MODERATION_PROVIDER=${env.MODERATION_PROVIDER} unsupported (use "mock" or "safety-gateway").`,
      );
  }
}

export function createProviders(): ChatProviders {
  return { moderation: createModerationProvider() };
}

let resolvedProviders: ChatProviders | null = null;
export const providers = new Proxy({} as ChatProviders, {
  get(_target, property: keyof ChatProviders) {
    resolvedProviders ??= createProviders();
    return resolvedProviders[property];
  },
});
