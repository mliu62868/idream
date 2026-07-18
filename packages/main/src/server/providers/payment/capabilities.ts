import type {
  PaymentProviderCapabilities,
} from "../types";

const prepaidPeriodCapabilities = {
  billingModel: "prepaid_period",
  renewalCapability: "none",
} as const satisfies PaymentProviderCapabilities;

const unknownCapabilities = {
  billingModel: "unknown",
  renewalCapability: "none",
} as const satisfies PaymentProviderCapabilities;

export function paymentProviderCapabilities(
  provider: string,
): PaymentProviderCapabilities {
  if (provider === "mock" || provider === "btcpay") {
    return prepaidPeriodCapabilities;
  }
  return unknownCapabilities;
}
