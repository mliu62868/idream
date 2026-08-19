import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { adminRouteLabel } from "@/app/admin/_server/render-admin-route";
import { ALL_SECTION_ITEMS, navItems } from "./nav-config";

// SPEC: 一个目的地只有一个名字 —— 页面头里的 title 必须是它那条导航项的 label。
//
// INTENT: shell 的粘性标题栏已经在印导航 label，页面自己再印一次就变成两个标题；更糟的是
// 两边曾有八处根本不是同一个词：侧栏「Billing Operations」→ 页内「Billing & Ledger」、
// 侧栏「Pricing」→ 页内「Pricing & Offers」、侧栏「Taxonomy」→ 页内「Tags」。运营点进去
// 会怀疑自己点错了。PageHeader 的 title 现在是 sr-only（保住标题层级与 aria-labelledby），
// 可见的名字只剩 shell 那一个——但字符串仍可能悄悄写歪，所以在这里钉死。
//
// INVARIANT: PageHeader title 只接受 t("<某个 nav label>")。新增页面就先在 nav-config 注册。
const SURFACES = [
  join(process.cwd(), "src", "components", "admin"),
  join(process.cwd(), "src", "features"),
];

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    if (!entry.name.endsWith(".tsx") || entry.name.includes(".test.")) return [];
    return [path];
  });
}

// PageHeader 也被 Risk/Providers 这类共享外壳以变量转发（title={title}）；
// 那些字面量在调用点已经被扫到，这里只看直接写死的字符串。
function literalTitle(attribute: ts.JsxAttribute): string | null {
  const value = attribute.initializer;
  if (!value || !ts.isJsxExpression(value) || !value.expression) return null;
  const expression = value.expression;
  if (ts.isStringLiteral(expression)) return expression.text;
  if (
    ts.isCallExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === "t" &&
    expression.arguments.length > 0 &&
    ts.isStringLiteral(expression.arguments[0])
  ) {
    return expression.arguments[0].text;
  }
  return null;
}

function pageHeaderTitles(file: string) {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: Array<{ location: string; title: string }> = [];

  const visit = (node: ts.Node) => {
    const opening = ts.isJsxSelfClosingElement(node)
      ? node
      : ts.isJsxElement(node)
        ? node.openingElement
        : null;
    if (opening && ts.isIdentifier(opening.tagName) && opening.tagName.text === "PageHeader") {
      for (const attribute of opening.attributes.properties) {
        if (!ts.isJsxAttribute(attribute) || attribute.name.getText(source) !== "title") continue;
        const title = literalTitle(attribute);
        if (title === null) continue;
        const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
        found.push({ location: `${relative(process.cwd(), file)}:${line}`, title });
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(source);
  return found;
}

describe("admin page naming", () => {
  it("names every page exactly as its navigation entry does", () => {
    const navLabels = new Set(ALL_SECTION_ITEMS.map((item) => item.label));
    const drifted = SURFACES
      .flatMap(sourceFiles)
      .flatMap(pageHeaderTitles)
      .filter((entry) => !navLabels.has(entry.title));

    expect(drifted).toEqual([]);
  });

  // 标签页标题曾按 URL 段拼装（"Ops · Providers"、"System · Access"），
  // 同时开一排后台标签页时，标题里的名字和侧栏对不上就找不回那一页。
  it("titles the browser tab with the same name the sidebar uses", () => {
    const titled = navItems.map((item) => {
      const [path = "", query = ""] = item.href.replace(/^\/admin\/?/, "").split("?", 2);
      const search = Object.fromEntries(new URLSearchParams(query));
      return {
        href: item.href,
        label: adminRouteLabel(path.split("/").filter(Boolean), search),
        expected: item.label,
      };
    });

    expect(titled.filter((entry) => entry.label !== entry.expected)).toEqual([]);
  });
});
