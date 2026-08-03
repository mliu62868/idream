import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// SPEC: @idream/shared is the cross-service contract SSoT. Its admission standard is
// mechanical, not editorial: every public export subpath must earn its place by being
// imported from more than one package.
//
// INTENT: shared drifts into a junk drawer one "it's kind of shared" module at a time.
// Prose in a README never stopped that. These two assertions do, by scanning the real
// import graph instead of trusting intent:
//   1. no DEAD subpath  — declared API face nobody imports (hard failure, no exceptions)
//   2. no undeclared SINGLE-consumer subpath — a one-package subpath is a module living
//      in the wrong package; it may stay only if someone writes down why, below.
//
// INVARIANT: SINGLE_CONSUMER_LEDGER is a debt list, not a config knob. Entries are
// expected to shrink. Adding one requires a reason that names the constraint keeping
// the module out of its real home — "it felt shared" is not a constraint.

const REPO_ROOT = new URL("../../..", import.meta.url).pathname.replace(/\/$/, "");
const PACKAGES_DIR = join(REPO_ROOT, "packages");
const SHARED_PKG = "shared";

/**
 * Subpaths that today have exactly one consuming package, with the constraint that
 * keeps them in shared. Anything not listed here must have >= 2 consumers.
 */
const SINGLE_CONSUMER_LEDGER: Record<string, { consumer: string; reason: string }> = {
  "@idream/shared/catalog": {
    consumer: "main",
    reason:
      "Product catalog (plans/pricing) is re-exported from the root barrel, which all four packages import. The subpath exists so main's server code can pull the catalog without dragging in the whole root barrel. Retire it if main stops being the only direct importer.",
  },
  "@idream/shared/admin/contracts": {
    consumer: "main",
    reason:
      "The admin control-plane schemas ARE two-package content: admin consumes every symbol through the `@idream/shared/admin` barrel (which re-exports ./contracts/index). main uses the narrower subpath to keep server code off the barrel. Not a relocation candidate.",
  },
  "@idream/shared/admin/api-manifest": {
    consumer: "main",
    reason:
      "Same shape as ./admin/contracts — admin reaches these symbols via the `@idream/shared/admin` barrel; main imports the narrow subpath because its route-manifest guard test loads it standalone.",
  },
};

// INVARIANT: 只扫源码。构建产物里留着搬家前的旧 import（.next-runtime 的 release 快照就是
// 这样让这条断言假阳性的），生成物里也有 Prisma 的自指符号链接。点开头的目录一律跳过，
// 这样新增一种缓存目录（.next / .turbo / .vercel …）不必回来改这张表。
const IGNORED_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "coverage",
  "generated",
]);
const SOURCE_FILE = /\.(?:ts|tsx|mts|cts|mjs|cjs|js|jsx)$/;

// INVARIANT: 不跟随符号链接。Prisma 会在 packages/chat/generated/client 下生成一个指向自身
// 的 client 链接，跟随它会无限递归（ELOOP）。仓库源码遍历只看树里的真实文件。
function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith(".") || IGNORED_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const stats = lstatSync(full);
    if (stats.isSymbolicLink()) continue;
    if (stats.isDirectory()) collectSourceFiles(full, out);
    else if (SOURCE_FILE.test(entry)) out.push(full);
  }
  return out;
}

function declaredSubpathSpecifiers(): string[] {
  const pkg = JSON.parse(
    readFileSync(join(PACKAGES_DIR, SHARED_PKG, "package.json"), "utf8"),
  ) as { exports: Record<string, string> };
  return Object.keys(pkg.exports).map((sub) =>
    sub === "." ? "@idream/shared" : `@idream/shared${sub.slice(1)}`,
  );
}

/** specifier -> packages that import it (shared itself never counts as a consumer). */
function buildConsumerIndex(): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();
  const packages = readdirSync(PACKAGES_DIR).filter((entry) =>
    lstatSync(join(PACKAGES_DIR, entry)).isDirectory(),
  );
  for (const pkg of packages) {
    if (pkg === SHARED_PKG) continue;
    for (const file of collectSourceFiles(join(PACKAGES_DIR, pkg))) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(
        /["'](@idream\/shared(?:\/[a-zA-Z0-9._-]+)*)["']/g,
      )) {
        const spec = match[1]!;
        let consumers = index.get(spec);
        if (!consumers) index.set(spec, (consumers = new Set()));
        consumers.add(pkg);
      }
    }
  }
  return index;
}

const consumerIndex = buildConsumerIndex();
const declared = declaredSubpathSpecifiers();

function consumersOf(specifier: string): string[] {
  return [...(consumerIndex.get(specifier) ?? [])].sort();
}

describe("@idream/shared export surface admission standard", () => {
  it("declares no subpath that nobody imports", () => {
    const dead = declared.filter((spec) => consumersOf(spec).length === 0);
    expect(
      dead,
      `Dead export subpath(s) in packages/shared/package.json: ${dead.join(", ")}.\n` +
        "An export nobody imports is API surface with no user. Delete the entry (the module\n" +
        "can stay reachable through a barrel), or delete the module.",
    ).toEqual([]);
  });

  it("declares no single-consumer subpath that is missing from the ledger", () => {
    const unjustified = declared.filter(
      (spec) => consumersOf(spec).length === 1 && !SINGLE_CONSUMER_LEDGER[spec],
    );
    expect(
      unjustified,
      `Single-consumer export subpath(s) with no ledger entry: ${unjustified
        .map((spec) => `${spec} (only ${consumersOf(spec)[0]})`)
        .join(", ")}.\n` +
        "One consumer means the module belongs in that package, not in shared. Move it there,\n" +
        "or add a SINGLE_CONSUMER_LEDGER entry naming the constraint that prevents the move.",
    ).toEqual([]);
  });

  it("keeps the ledger honest — every entry is still single-consumer and still that consumer", () => {
    const stale: string[] = [];
    for (const [spec, entry] of Object.entries(SINGLE_CONSUMER_LEDGER)) {
      const actual = consumersOf(spec);
      if (!declared.includes(spec)) {
        stale.push(`${spec}: no longer a declared export — drop the ledger entry`);
        continue;
      }
      if (actual.length !== 1) {
        stale.push(
          `${spec}: now has ${actual.length} consumer(s) [${actual.join(", ")}] — ` +
            (actual.length > 1
              ? "it graduated, drop the ledger entry"
              : "it is dead, drop the export"),
        );
        continue;
      }
      if (actual[0] !== entry.consumer) {
        stale.push(
          `${spec}: ledger says "${entry.consumer}" but the only consumer is "${actual[0]}"`,
        );
      }
    }
    expect(stale, `Stale SINGLE_CONSUMER_LEDGER entries:\n  ${stale.join("\n  ")}`).toEqual(
      [],
    );
  });

  it("every ledger entry states a constraint, not a vibe", () => {
    for (const [spec, entry] of Object.entries(SINGLE_CONSUMER_LEDGER)) {
      expect(entry.reason.length, `${spec} needs a real reason`).toBeGreaterThan(80);
    }
  });

  it("has no import of an @idream/shared specifier that package.json does not export", () => {
    const undeclared = [...consumerIndex.keys()]
      .filter((spec) => !declared.includes(spec))
      .sort();
    expect(
      undeclared,
      `Imported but undeclared specifier(s): ${undeclared.join(", ")}.\n` +
        "These resolve only by accident of file layout. Add them to exports or stop importing them.",
    ).toEqual([]);
  });
});
