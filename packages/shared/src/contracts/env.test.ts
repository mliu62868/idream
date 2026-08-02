import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BLOB_ACCESS_KEY_ID_ALIASES,
  BLOB_SECRET_ACCESS_KEY_ALIASES,
  DEFAULT_APP_ENV,
  DEFAULT_MAIN_WEB_URL,
  DEFAULT_MODERATION_TIMEOUT_MS,
  DEFAULT_REDIS_URL,
  crossServiceEnvShape,
  defaultBullmqPrefix,
  mainWebUrlOrigin,
  resolveAlias,
} from "./env";

// SPEC: this guard is the enforcement half of the cross-service env contract.
// INTENT: defining the defaults once only helps if nobody quietly re-types the
// literal next to the import. BULLMQ_PREFIX was copied into three env.ts files and
// a mismatch is silent — producer enqueues, consumer polls a different keyspace,
// both processes look healthy. So: scan the three env.ts files and fail if any of
// them re-declares a shared default inline.

const ROOT = new URL("../../../..", import.meta.url).pathname.replace(/\/$/, "");
const SERVICE_ENV_FILES = {
  main: `${ROOT}/packages/main/src/server/lib/env.ts`,
  chat: `${ROOT}/packages/chat/src/env.ts`,
  gen: `${ROOT}/packages/gen/src/env.ts`,
} as const;

/** Literals that must exist in exactly one place: @idream/shared/env. */
const FORBIDDEN_INLINE_LITERALS: { pattern: RegExp; owner: string }[] = [
  { pattern: /`idream:\$\{/, owner: "defaultBullmqPrefix()" },
  { pattern: /"idream:/, owner: "defaultBullmqPrefix()" },
  { pattern: /redis:\/\/127\.0\.0\.1:6379\/0/, owner: "DEFAULT_REDIS_URL" },
  { pattern: /http:\/\/127\.0\.0\.1:3000/, owner: "DEFAULT_MAIN_WEB_URL" },
];

describe("cross-service env contract", () => {
  it("is the only place the shared defaults are written down", () => {
    const violations: string[] = [];
    for (const [service, file] of Object.entries(SERVICE_ENV_FILES)) {
      const source = readFileSync(file, "utf8");
      for (const { pattern, owner } of FORBIDDEN_INLINE_LITERALS) {
        if (pattern.test(source)) {
          violations.push(`${service} (${file}) inlines ${pattern} — import ${owner} instead`);
        }
      }
    }
    expect(
      violations,
      `Cross-service env default re-declared outside @idream/shared/env:\n  ${violations.join("\n  ")}`,
    ).toEqual([]);
  });

  it("has all three services importing the contract", () => {
    for (const [service, file] of Object.entries(SERVICE_ENV_FILES)) {
      const source = readFileSync(file, "utf8");
      expect(source, `${service} must consume @idream/shared/env`).toContain(
        '"@idream/shared/env"',
      );
    }
  });

  it("builds the queue prefix from APP_ENV, defaulting to development", () => {
    expect(defaultBullmqPrefix("production")).toBe("idream:production");
    expect(defaultBullmqPrefix("test")).toBe("idream:test");
    expect(defaultBullmqPrefix(undefined)).toBe(`idream:${DEFAULT_APP_ENV}`);
    expect(defaultBullmqPrefix()).toBe("idream:development");
  });

  it("normalises the main origin the same way for every caller", () => {
    expect(mainWebUrlOrigin("https://example.com/")).toBe("https://example.com");
    expect(mainWebUrlOrigin("https://example.com")).toBe("https://example.com");
    expect(mainWebUrlOrigin(undefined)).toBe(DEFAULT_MAIN_WEB_URL);
  });

  it("resolves credential aliases with ?? semantics — empty string wins over the next alias", () => {
    expect(
      resolveAlias(BLOB_ACCESS_KEY_ID_ALIASES, {
        BLOB_ACCESS_KEY: "second",
        AWS_ACCESS_KEY_ID: "third",
      }),
    ).toBe("second");
    expect(
      resolveAlias(BLOB_SECRET_ACCESS_KEY_ALIASES, { BLOB_SECRET_ACCESS_KEY: "" }),
    ).toBe("");
    expect(resolveAlias(BLOB_ACCESS_KEY_ID_ALIASES, {})).toBeUndefined();
  });

  it("keeps main's zod shape defaults identical to the constants chat and gen use", () => {
    const shape = crossServiceEnvShape("preview");
    expect(shape.REDIS_URL.parse(undefined)).toBe(DEFAULT_REDIS_URL);
    expect(shape.BULLMQ_PREFIX.parse(undefined)).toBe("idream:preview");
    expect(shape.MODERATION_TIMEOUT_MS.parse(undefined)).toBe(DEFAULT_MODERATION_TIMEOUT_MS);
    expect(shape.MODERATION_PROVIDER.parse(undefined)).toBe("mock");
    expect(shape.APP_ENV.parse(undefined)).toBe(DEFAULT_APP_ENV);
  });
});
