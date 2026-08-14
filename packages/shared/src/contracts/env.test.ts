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
  mainProviderKeysForLaunchScope,
  mainWebUrlOrigin,
  pipelineEndpoint,
  requiredNonMockMainProviderKeysForLaunchScope,
  resolveAlias,
  resolveLaunchScope,
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

// SPEC: 共享的**解析**也只能有一份，不只是共享的默认值。
// INTENT: 上面两条守卫盯的是字面量常量，可是 redisConnectionOptions 与
//   pipelineEndpoint 这类"把一个字符串拆成结构"的函数，是被整段手抄的 ——
//   REDIS_URL 的解析在 main/chat/gen 三个 queue.ts 里逐字节抄了三遍（db 索引
//   来自 URL 路径，抄歪一份就是生产者与消费者连到不同的库，两边都不报错、什么
//   也不投递）；pipelineEndpoint 抄成了两种语义，gen 那份直接忽略 route，于是
//   图和视频解析到同一个 URL。
//   所以扫描域是**整棵 src 树**（不是三个 env.ts，也不是 probe-*.ts），指纹用
//   这些解析里最独特的那一行 —— 换个函数名重抄一遍照样会被抓到。
const SERVICE_SOURCE_ROOTS = [
  `${ROOT}/packages/main/src`,
  `${ROOT}/packages/chat/src`,
  `${ROOT}/packages/gen/src`,
];

const HAND_ROLLED_PARSES: { fingerprint: string; owner: string }[] = [
  {
    // PostgreSQL URLs legitimately decode credentials too. The BullMQ-only
    // invariant is the blocking Redis retry policy, so key the guard to that
    // instead of rejecting every URL parser in the repository.
    fingerprint: "maxRetriesPerRequest: null",
    owner: "redisConnectionOptions() from @idream/shared/env",
  },
  {
    fingerprint: "pathname.endsWith(",
    owner: "pipelineEndpoint() from @idream/shared/env",
  },
  // 别名链的**末位**单独出现，只可能是有人又把整条链手抄了一遍 —— 没有别的理由
  // 去读 AWS_* 而不读前面两种拼写。probe-blob-storage 就抄过一次：探针用一条链
  // 认证成功、gen 用另一条链认证失败，正是 BLOB_*_ALIASES 的 SPEC 警告过的事。
  {
    fingerprint: "process.env.AWS_ACCESS_KEY_ID",
    owner: "resolveAlias(BLOB_ACCESS_KEY_ID_ALIASES) from @idream/shared/env",
  },
  {
    fingerprint: "process.env.AWS_SECRET_ACCESS_KEY",
    owner: "resolveAlias(BLOB_SECRET_ACCESS_KEY_ALIASES) from @idream/shared/env",
  },
];

function serviceSourceFiles(): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "generated") continue;
        walk(full);
      } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
        found.push(full);
      }
    }
  };
  for (const root of SERVICE_SOURCE_ROOTS) walk(root);
  return found;
}

describe("共享解析只能有一份", () => {
  it("扫描域覆盖到整棵 src 树，而不是空转", () => {
    expect(serviceSourceFiles().length).toBeGreaterThan(300);
  });

  it("没有服务自己再手写一遍共享的解析", () => {
    const violations: string[] = [];
    for (const file of serviceSourceFiles()) {
      const source = readFileSync(file, "utf8");
      for (const { fingerprint, owner } of HAND_ROLLED_PARSES) {
        if (source.includes(fingerprint)) {
          violations.push(`${file.replace(`${ROOT}/`, "")} 手写了 ${fingerprint} —— 改用 ${owner}`);
        }
      }
    }
    expect(
      violations,
      `共享解析被重新手抄，两份拷贝迟早给出不同答案：\n  ${violations.join("\n  ")}`,
    ).toEqual([]);
  });
});

describe("cross-service env contract", () => {
  it("keeps launch scope parsing and Main provider requirements in one contract", () => {
    expect(resolveLaunchScope(undefined)).toBe("full");
    expect(resolveLaunchScope("  core  ")).toBe("core");
    expect(resolveLaunchScope("skip")).toBeNull();
    expect(mainProviderKeysForLaunchScope("core")).toEqual([
      "CHAT_PROVIDER",
      "VOICE_PROVIDER",
      "MODERATION_PROVIDER",
      "BLOB_PROVIDER",
    ]);
    expect(requiredNonMockMainProviderKeysForLaunchScope("core")).toEqual([
      "CHAT_PROVIDER",
      "VOICE_PROVIDER",
      "BLOB_PROVIDER",
    ]);
    expect(requiredNonMockMainProviderKeysForLaunchScope("full")).toEqual([
      "CHAT_PROVIDER",
      "VOICE_PROVIDER",
      "BLOB_PROVIDER",
      "PAYMENT_PROVIDER",
      "AGE_VERIFICATION_PROVIDER",
    ]);
  });

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

  // Regression: gen returned the configured base UNCHANGED whenever it carried a
  // path, so `/images/generations` and `/videos/generations` resolved to the same
  // URL and video requests went to the image endpoint; under main's documented
  // `.../v1` base it posted to `/v1` and never reached a route at all.
  it("resolves every pipeline route off one base, for every adapter", () => {
    const base = "http://127.0.0.1:8061/v1";
    expect(pipelineEndpoint(base, "/chat/completions").toString()).toBe(
      "http://127.0.0.1:8061/v1/chat/completions",
    );
    expect(pipelineEndpoint(base, "/audio/speech").toString()).toBe(
      "http://127.0.0.1:8061/v1/audio/speech",
    );
    // The two generation routes must never collapse onto each other.
    expect(pipelineEndpoint(base, "/images/generations").toString()).not.toBe(
      pipelineEndpoint(base, "/videos/generations").toString(),
    );
  });

  it("accepts a base that is already the complete endpoint, without doubling it", () => {
    expect(
      pipelineEndpoint("http://127.0.0.1:8091/images/generations", "/images/generations")
        .toString(),
    ).toBe("http://127.0.0.1:8091/images/generations");
    // Root and trailing-slash bases both land on the bare route.
    expect(pipelineEndpoint("http://host", "/chat/completions").toString()).toBe(
      "http://host/chat/completions",
    );
    expect(pipelineEndpoint("http://host/v1/", "/chat/completions").toString()).toBe(
      "http://host/v1/chat/completions",
    );
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
