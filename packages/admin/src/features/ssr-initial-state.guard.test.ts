import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// SPEC: useState 初值必须在服务端与客户端首帧得出同一个值。
// INTENT: `typeof window === "undefined" ? fallback : window.location.search` 这种写法
//         看着像防护，实际是 hydration mismatch 的制造机 —— 服务端拿 fallback、客户端
//         首帧拿真实 URL，两边分叉。GenerationConfigWorkspace 曾因此一次渲染报 56 条
//         React 水合告警，OverviewWorkspaces 有两处同族。地址栏只能在 effect 里读。
// INVARIANT: 这条守卫盯的是「初值表达式里出现 window/location/document」，
//            不限制 effect、事件回调与 ref 里的用法。

const SRC = fileURLToPath(new URL("../", import.meta.url));

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const full = join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`SSR guard refuses symlinked source entries: ${full}`);
    }
    if (entry.isDirectory()) {
      out.push(...sourceFiles(full));
      continue;
    }
    if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) continue;
    out.push(full);
  }
  return out;
}

function unsafeUseStateInitializers(text: string, fileName: string): string[] {
  const source = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const found: string[] = [];

  function containsBrowserAuthority(node: ts.Node) {
    let unsafe = false;
    function visit(candidate: ts.Node) {
      if (
        ts.isIdentifier(candidate) &&
        ["window", "document"].includes(candidate.text)
      ) {
        unsafe = true;
      }
      if (
        ts.isTypeOfExpression(candidate) &&
        ts.isIdentifier(candidate.expression) &&
        candidate.expression.text === "window"
      ) {
        unsafe = true;
      }
      if (
        ts.isPropertyAccessExpression(candidate) &&
        ((ts.isIdentifier(candidate.expression) &&
          ["window", "document"].includes(candidate.expression.text)) ||
          (candidate.name.text === "search" &&
            ts.isIdentifier(candidate.expression) &&
            candidate.expression.text === "location"))
      ) {
        unsafe = true;
      }
      if (!unsafe) ts.forEachChild(candidate, visit);
    }
    visit(node);
    return unsafe;
  }

  function visit(node: ts.Node) {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "useState" &&
      node.arguments[0] &&
      containsBrowserAuthority(node.arguments[0])
    ) {
      found.push(node.arguments[0].getText(source));
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return found;
}

describe("SSR-safe initial state", () => {
  it("never reads the address bar or document inside a useState initialiser", () => {
    const offenders: string[] = [];
    const files = sourceFiles(SRC);
    expect(files.length).toBeGreaterThan(20);
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      if (!text.includes("useState")) continue;
      for (const expression of unsafeUseStateInitializers(text, file)) {
        offenders.push(`${file.replace(SRC, "")}: useState(${expression.trim().slice(0, 90)})`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("parses nested generics and ignores comments and string literals", () => {
    expect(unsafeUseStateInitializers(
      `const state = useState<Map<string, Array<number>>>(() => window.location.search);`,
      "unsafe.tsx",
    )).toEqual(["() => window.location.search"]);
    expect(unsafeUseStateInitializers(
      `const state = useState("window.location.search"); // document.body`,
      "safe.tsx",
    )).toEqual([]);
    expect(unsafeUseStateInitializers(
      `const state = useState(() => window["location"].search);`,
      "element-access.tsx",
    )).toEqual([`() => window["location"].search`]);
  });

  it("refuses to follow symlinked source entries", () => {
    const root = mkdtempSync(join(tmpdir(), "idream-ssr-guard-"));
    try {
      const source = join(root, "source");
      mkdirSync(source);
      writeFileSync(join(root, "outside.tsx"), "export const outside = true;\n");
      symlinkSync(join(root, "outside.tsx"), join(source, "linked.tsx"));
      expect(() => sourceFiles(source)).toThrow("refuses symlinked source entries");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
