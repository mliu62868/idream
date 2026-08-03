import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  chatModelTimeoutMs,
  DEFAULT_CHAT_MODEL_TIMEOUT_MS,
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

// SPEC: 探针不得自己再解析一遍生产的预算。
// INTENT: 上面那条守卫的扫描域是写死的三个 env.ts —— 而实际漂移发生在
//   main/src/server/probe-chat-model.ts：它把超时解析成
//   `CHAT_MODEL_TIMEOUT_MS ?? PIPELINE_TIMEOUT_MS ?? 60000`，比 chat 生产的
//   `CHAT_MODEL_TIMEOUT_MS ?? 45000` 多一级回退、默认值也更大，于是一次 50s 的
//   响应在探针里全绿、在 chat 里早已超时。守卫的形状决定它能抓住什么：一张写死的
//   文件清单只能抓清单里的漂移，所以这一条用**目录通配**做扫描域 —— 将来新增的
//   探针自动被覆盖，不需要有人记得回来加一行。
const PROBE_DIR = `${ROOT}/packages/main/src/server`;
const SHARED_BUDGET_OWNERS: { envVar: string; owner: string }[] = [
  { envVar: "CHAT_MODEL_TIMEOUT_MS", owner: "chatModelTimeoutMs() from @idream/shared/env" },
];

function probeFiles(): string[] {
  return readdirSync(PROBE_DIR)
    .filter((name) => /^probe-.*\.ts$/.test(name) && !name.endsWith(".test.ts"))
    .map((name) => `${PROBE_DIR}/${name}`);
}

describe("探针必须复用生产的预算", () => {
  it("扫描域真的覆盖到了一批探针，而不是空转", () => {
    // 守卫自检：通配符没匹配到东西时，上面那条断言会无声通过。
    expect(probeFiles().length).toBeGreaterThan(5);
  });

  it("没有探针自己解析带共享属主的预算变量", () => {
    const violations: string[] = [];
    for (const file of probeFiles()) {
      const source = readFileSync(file, "utf8");
      for (const { envVar, owner } of SHARED_BUDGET_OWNERS) {
        if (source.includes(`process.env.${envVar}`)) {
          violations.push(`${file.split("/").pop()} 自行解析 ${envVar} —— 改用 ${owner}`);
        }
      }
    }
    expect(
      violations,
      `探针重新解析了生产预算，报告出来的健康与生产行为不是一回事：\n  ${violations.join("\n  ")}`,
    ).toEqual([]);
  });
});

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

  it("resolves the chat model budget the same way for chat and for the probe", () => {
    expect(chatModelTimeoutMs("30000")).toBe(30_000);
    expect(chatModelTimeoutMs(undefined)).toBe(DEFAULT_CHAT_MODEL_TIMEOUT_MS);
    // 非法值回落到默认，而不是变成 NaN 让 fetch 立即放弃。
    expect(chatModelTimeoutMs("not-a-number")).toBe(DEFAULT_CHAT_MODEL_TIMEOUT_MS);
    expect(chatModelTimeoutMs("0")).toBe(DEFAULT_CHAT_MODEL_TIMEOUT_MS);
    expect(chatModelTimeoutMs("-1")).toBe(DEFAULT_CHAT_MODEL_TIMEOUT_MS);
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
