import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// SPEC: 中文文案按功能域分文件，i18n.tsx 把它们展开合并成一张扁平表。本测试守住合并的前提：
// key 在域文件之间互斥。
// INTENT: 扁平词典没有命名空间，同名即冲突；而 TypeScript 对对象展开中的重复 key 不报错，
// 后展开的静默覆盖先展开的。重切分片前，a/g 之间的 "{cost} DC"、"Completed"，b/d 之间的
// "Recently resolved"，c/g 之间的 "Video" 就是这样被静默覆盖的，没有任何测试发现。
// INVARIANT: 任一 key 只能由一个域文件持有；域文件必须被 i18n.tsx 导入并展开。
const DIRECTORY = join(process.cwd(), "src", "components", "admin");

function domainFiles(): string[] {
  return readdirSync(DIRECTORY)
    .filter((name) => name.startsWith("i18n-zh-") && name.endsWith(".ts") && !name.includes(".test."))
    .sort();
}

function parse(name: string) {
  const path = join(DIRECTORY, name);
  return ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

// SPEC: 走 AST 而不是 import 域文件——import 会让「同一文件内的重复 key」在读到之前就被合并掉，
// 正是这个测试要抓的东西。
function objectLiteralKeys(sourceFile: ts.SourceFile): string[] {
  const keys: string[] = [];

  function visit(node: ts.Node) {
    if (ts.isObjectLiteralExpression(node)) {
      for (const property of node.properties) {
        if (!ts.isPropertyAssignment(property)) continue;
        const name = property.name;
        if (ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name) || ts.isIdentifier(name)) {
          keys.push(name.text);
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return keys;
}

function exportedConstName(sourceFile: ts.SourceFile): string | null {
  let found: string | null = null;

  function visit(node: ts.Node) {
    if (
      ts.isVariableStatement(node) &&
      node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      for (const declaration of node.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) found ??= declaration.name.text;
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return found;
}

/**
 * 合并点 = 展开了域常量的那个源文件。不写死文件名：i18n.tsx / i18n-dictionary.ts
 * 之间搬过一次，将来还可能再搬。
 */
function mergeEntrySource(): ts.SourceFile {
  const candidates = readdirSync(DIRECTORY).filter(
    (name) =>
      /\.tsx?$/.test(name) &&
      !name.includes(".test.") &&
      !name.startsWith("i18n-zh-"),
  );
  const domainConstNames = new Set(
    domainFiles()
      .map((name) => exportedConstName(parse(name)))
      .filter((name): name is string => Boolean(name)),
  );

  for (const name of candidates) {
    const text = readFileSync(join(DIRECTORY, name), "utf8");
    if (![...domainConstNames].some((constName) => text.includes(constName))) continue;
    return ts.createSourceFile(
      join(DIRECTORY, name),
      text,
      ts.ScriptTarget.Latest,
      true,
      name.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
  }
  throw new Error(
    `No source in ${DIRECTORY} spreads the zh domain dictionaries; the merge point is missing.`,
  );
}

describe("admin zh domain dictionaries", () => {
  it("never assigns the same key in two domain files", () => {
    const owner = new Map<string, string>();
    const collisions: string[] = [];

    for (const name of domainFiles()) {
      for (const key of new Set(objectLiteralKeys(parse(name)))) {
        const previous = owner.get(key);
        if (previous) collisions.push(`${JSON.stringify(key)}: ${previous} + ${name}`);
        else owner.set(key, name);
      }
    }

    expect(collisions).toEqual([]);
  });

  it("never repeats a key inside one domain file", () => {
    const duplicates: string[] = [];

    for (const name of domainFiles()) {
      const seen = new Set<string>();
      for (const key of objectLiteralKeys(parse(name))) {
        if (seen.has(key)) duplicates.push(`${name} ${JSON.stringify(key)}`);
        seen.add(key);
      }
    }

    expect(duplicates).toEqual([]);
  });

  // SPEC: 新建一个域文件却忘了接线，界面会静默退回英文而其它测试全绿——所以在这里拦住。
  // INTENT: 合并点原先在 i18n.tsx，后来搬进 i18n-dictionary.ts，而这条断言把文件名写死了，
  //         于是 9 个域文件明明接线正常却全被报成「未合并」。改成按「谁展开了域常量」去找，
  //         合并点再搬一次也不会假红。
  it("merges every domain file into the zh dictionary", () => {
    const entry = mergeEntrySource();

    const spreadNames = new Set<string>();
    function visit(node: ts.Node) {
      if (ts.isVariableDeclaration(node) && node.name.getText(entry) === "zh" && node.initializer && ts.isObjectLiteralExpression(node.initializer)) {
        for (const property of node.initializer.properties) {
          if (ts.isSpreadAssignment(property) && ts.isIdentifier(property.expression)) {
            spreadNames.add(property.expression.text);
          }
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(entry);

    const unmerged = domainFiles().filter((name) => {
      const constName = exportedConstName(parse(name));
      return !constName || !spreadNames.has(constName);
    });

    expect(unmerged).toEqual([]);
    expect(spreadNames.size).toBe(domainFiles().length);
  });
});
