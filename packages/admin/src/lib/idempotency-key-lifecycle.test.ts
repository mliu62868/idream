import { describe, expect, it } from "vitest";
import {
  createIdempotencyKeyLedger,
  idempotencyOutcomeOfStatus,
} from "./idempotency-key-lifecycle";

function countingLedger() {
  let issued = 0;
  return createIdempotencyKeyLedger(() => `key-${++issued}`);
}

describe("idempotency key ledger", () => {
  it("issues one key the first time an intent is written", () => {
    const ledger = countingLedger();

    expect(ledger.claim("POST /incidents/i1/close", "reason=done")).toBe("key-1");
    expect(ledger.held).toBe(1);
  });

  it("hands the same key to a retry of the same intent", () => {
    const ledger = countingLedger();

    const first = ledger.claim("POST /incidents/i1/close", "reason=done");
    ledger.settle("POST /incidents/i1/close", first, "unknown");
    const retry = ledger.claim("POST /incidents/i1/close", "reason=done");

    expect(retry).toBe(first);
  });

  it("issues a new key once the operator changes what they are writing", () => {
    const ledger = countingLedger();

    const first = ledger.claim("POST /incidents/i1/close", "reason=done");
    const changed = ledger.claim("POST /incidents/i1/close", "reason=fixed upstream");

    expect(changed).not.toBe(first);
    expect(ledger.held).toBe(1);
  });

  it("keeps separate keys for the same command on different targets", () => {
    const ledger = countingLedger();

    const first = ledger.claim("POST /incidents/i1/close", "reason=done");
    const other = ledger.claim("POST /incidents/i2/close", "reason=done");

    expect(other).not.toBe(first);
    expect(ledger.held).toBe(2);
  });

  it("recycles the key once the server answered, so the next click is a new write", () => {
    const ledger = countingLedger();

    const first = ledger.claim("POST /incidents/i1/close", "reason=done");
    ledger.settle("POST /incidents/i1/close", first, "answered");

    expect(ledger.held).toBe(0);
    expect(ledger.claim("POST /incidents/i1/close", "reason=done")).not.toBe(first);
  });

  it("keeps the key when the outcome is unknown, so the retry cannot write twice", () => {
    const ledger = countingLedger();

    const first = ledger.claim("POST /incidents/i1/close", "reason=done");
    ledger.settle("POST /incidents/i1/close", first, "unknown");

    expect(ledger.held).toBe(1);
    expect(ledger.claim("POST /incidents/i1/close", "reason=done")).toBe(first);
  });

  it("ignores a late settle from a key the operator has already replaced", () => {
    const ledger = countingLedger();

    const abandoned = ledger.claim("POST /incidents/i1/close", "reason=done");
    const current = ledger.claim("POST /incidents/i1/close", "reason=fixed upstream");
    ledger.settle("POST /incidents/i1/close", abandoned, "answered");

    expect(ledger.claim("POST /incidents/i1/close", "reason=fixed upstream")).toBe(current);
  });
});

describe("outcome of a failed write", () => {
  it("treats a definite server rejection as answered", () => {
    expect(idempotencyOutcomeOfStatus(409)).toBe("answered");
    expect(idempotencyOutcomeOfStatus(422)).toBe("answered");
    expect(idempotencyOutcomeOfStatus(429)).toBe("answered");
  });

  it("treats a lost or timed-out response as unknown", () => {
    expect(idempotencyOutcomeOfStatus(undefined)).toBe("unknown");
    expect(idempotencyOutcomeOfStatus(408)).toBe("unknown");
    expect(idempotencyOutcomeOfStatus(502)).toBe("unknown");
    expect(idempotencyOutcomeOfStatus(504)).toBe("unknown");
  });
});
