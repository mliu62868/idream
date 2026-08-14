import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as evidence from "./evidence";
import {
  loadProbeReport,
  PROBE_NAMES,
  PROBE_REPORTS,
  resolveWorkspacePath,
  writeProbeReport,
} from "./probe-report";

// SPEC: 一个 probe 的 env 变量名此前在 6 处字面量里各存一份（生产端 1、消费端 5），没有任何东西
//       对账“probe 写的 key”与“门禁读的 key”是同一个。现在只有 PROBE_REPORTS 一份。
// INTENT: 守卫断言的是集合相等，不是符号黑名单 —— 换个名字、搬到别的文件都会被抓到。

const readinessDir = path.dirname(fileURLToPath(import.meta.url));
const mainSrcRoot = path.resolve(readinessDir, "../..");
const registryFile = path.join(readinessDir, "probe-report.ts");

function sourceFiles(root: string): string[] {
  // INVARIANT: 只扫源码 —— 不跟随符号链接（Prisma 生成物里有自指链接），跳过点开头与生成物目录。
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      out.push(...sourceFiles(full));
      continue;
    }
    if (!entry.isFile()) continue;
    if (!/\.tsx?$/.test(entry.name)) continue;
    out.push(full);
  }
  return out;
}

describe("launch probe report registry", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("binds persisted evidence to the producing source revision", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "idream-probe-revision-"));
    const reportPath = path.join(directory, "chat-model.json");
    vi.stubEnv("SENTRY_RELEASE", "idream@revision-abc123");
    try {
      await writeProbeReport(reportPath, {
        ok: true,
        checkedAt: "2026-08-12T00:00:00.000Z",
      });
      const loaded = loadProbeReport(
        { CHAT_MODEL_PROBE_REPORT: reportPath },
        "chatModelProbe",
      );
      expect(loaded?.sourceRevision).toBe("idream@revision-abc123");
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });
  it("registers every evidence decoder exactly once", () => {
    const declaredDecoders = Object.entries(evidence)
      .filter(([name, value]) => name.startsWith("decode") && typeof value === "function")
      .map(([, value]) => value as unknown);
    // 自检：契约文件真的被扫到了，而不是 import 到了空对象。
    expect(declaredDecoders.length).toBeGreaterThanOrEqual(11);

    const registered = PROBE_NAMES.map((name) => PROBE_REPORTS[name].decode as unknown);
    expect(new Set(registered).size).toBe(registered.length);
    expect(new Set(registered)).toEqual(new Set(declaredDecoders));
  });

  it("gives every probe a distinct report and max-age env key", () => {
    const reportKeys = PROBE_NAMES.map((name) => PROBE_REPORTS[name].reportEnvKey);
    const maxAgeKeys = PROBE_NAMES.map((name) => PROBE_REPORTS[name].maxAgeEnvKey);
    expect(new Set(reportKeys).size).toBe(reportKeys.length);
    expect(new Set(maxAgeKeys).size).toBe(maxAgeKeys.length);
    expect(reportKeys.every((key) => /^[A-Z0-9_]+_PROBE_REPORT$/.test(key))).toBe(true);
    expect(maxAgeKeys.every((key) => /^[A-Z0-9_]+_PROBE_MAX_AGE_MINUTES$/.test(key))).toBe(true);
  });

  // SPEC: 集合相等，不是黑名单。任何非测试源码文件重新拼出一个已注册的 probe env key ——
  //       无论叫什么名字、住在哪个文件 —— 都会让这条失败。
  it("keeps every registered probe env key inside the registry file only", () => {
    const registered = new Set([
      ...PROBE_NAMES.map((name) => PROBE_REPORTS[name].reportEnvKey),
      ...PROBE_NAMES.map((name) => PROBE_REPORTS[name].maxAgeEnvKey),
    ]);
    const files = sourceFiles(mainSrcRoot).filter((file) => !file.endsWith(".test.ts"));
    // 自检：目录改名后不能静默扫到空集合。
    expect(files.length).toBeGreaterThan(200);
    expect(files).toContain(registryFile);
    expect(files).toContain(path.join(mainSrcRoot, "server", "launch-readiness.ts"));

    const spellers = new Map<string, string[]>();
    const seenInRegistry = new Set<string>();
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const key of registered) {
        if (!text.includes(key)) continue;
        if (file === registryFile) {
          seenInRegistry.add(key);
          continue;
        }
        spellers.set(key, [...(spellers.get(key) ?? []), path.relative(mainSrcRoot, file)]);
      }
    }

    expect(Object.fromEntries(spellers)).toEqual({});
    // 自检：扫描确实命中了注册表本身的全部键，而不是正则/路径写错扫了个寂寞。
    expect(seenInRegistry).toEqual(registered);
  });

  it("resolves relative report paths against the workspace root for both sides", () => {
    // 生产端写、消费端读必须落到同一个文件 —— 两侧都只调这一个 resolveWorkspacePath，
    // 而它把相对路径锚在 workspace 根（bun.lock/turbo.json 所在层），不是各自的 cwd。
    const resolved = resolveWorkspacePath(".tmp/launch-probe.json");
    expect(path.isAbsolute(resolved)).toBe(true);
    const root = path.dirname(path.dirname(resolved));
    expect(statSync(path.join(root, "turbo.json")).isFile()).toBe(true);
    expect(resolveWorkspacePath("/already/absolute.json")).toBe("/already/absolute.json");
  });
});
