import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { hasAdminZh } from "./i18n";

const ADMIN_SURFACES = [
  join(process.cwd(), "src", "app", "admin"),
  join(process.cwd(), "src", "components", "admin"),
  join(process.cwd(), "src", "features"),
];
const VISIBLE_TEXT_ATTRIBUTES = new Set(["alt", "aria-label", "placeholder", "title"]);
const TRANSLATED_PROP_ATTRIBUTES = new Set([
  "authority",
  "caption",
  "confirmText",
  "description",
  "empty",
  "emptyText",
  "errorMessage",
  "eyebrow",
  "helperText",
  "hint",
  "label",
  "loadingLabel",
  "message",
  "meta",
  "purpose",
  "searchPlaceholder",
]);
const INTENTIONAL_LITERALS = new Set(["English", "iDream Admin"]);

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    if (!entry.name.endsWith(".tsx") || entry.name.includes(".test.")) return [];
    return [path];
  });
}

function containsEnglish(value: string) {
  const normalized = value.replace(/\s+/g, " ").trim();
  return (
    /[A-Za-z]{2}/.test(normalized) &&
    !/[\u3400-\u9fff]/.test(normalized) &&
    !INTENTIONAL_LITERALS.has(normalized)
  );
}

function sourceLocation(sourceFile: ts.SourceFile, node: ts.Node) {
  const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  return `${relative(process.cwd(), sourceFile.fileName)}:${line}`;
}

function jsxExpressionAuditState(node: ts.Node) {
  let ancestor: ts.Node | undefined = node.parent;
  let translated = false;
  let jsxExpression: ts.JsxExpression | undefined;
  while (ancestor && !ts.isStatement(ancestor) && !ts.isSourceFile(ancestor)) {
    if (ts.isCallExpression(ancestor)) translated = true;
    if (ts.isJsxExpression(ancestor)) {
      jsxExpression = ancestor;
      break;
    }
    ancestor = ancestor.parent;
  }
  return { jsxExpression, translated };
}

function auditAdminTranslations() {
  const missingTranslations: string[] = [];
  const untranslatedJsx: string[] = [];

  for (const file of ADMIN_SURFACES.flatMap(sourceFiles)) {
    const sourceFile = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );

    function visit(node: ts.Node) {
      if (ts.isCallExpression(node)) {
        const callee = node.expression.getText(sourceFile);
        const keyArgument = callee === "translateAdmin" ? node.arguments[1] : node.arguments[0];
        if (
          (callee === "t" || callee === "translateAdmin") &&
          keyArgument &&
          (ts.isStringLiteral(keyArgument) || ts.isNoSubstitutionTemplateLiteral(keyArgument)) &&
          !hasAdminZh(keyArgument.text)
        ) {
          missingTranslations.push(
            `${sourceLocation(sourceFile, keyArgument)} ${JSON.stringify(keyArgument.text)}`,
          );
        }
      }

      if (
        ts.isJsxAttribute(node) &&
        node.name.getText(sourceFile) === "text" &&
        ts.isJsxSelfClosingElement(node.parent.parent) &&
        node.parent.parent.tagName.getText(sourceFile) === "AdminText" &&
        node.initializer &&
        ts.isStringLiteral(node.initializer) &&
        !hasAdminZh(node.initializer.text)
      ) {
        missingTranslations.push(
          `${sourceLocation(sourceFile, node)} ${JSON.stringify(node.initializer.text)}`,
        );
      }

      if (
        ts.isJsxAttribute(node) &&
        TRANSLATED_PROP_ATTRIBUTES.has(node.name.getText(sourceFile)) &&
        node.initializer &&
        ts.isStringLiteral(node.initializer) &&
        containsEnglish(node.initializer.text) &&
        !hasAdminZh(node.initializer.text)
      ) {
        missingTranslations.push(
          `${sourceLocation(sourceFile, node)} ${node.name.getText(sourceFile)}=${JSON.stringify(node.initializer.text)}`,
        );
      }

      if (ts.isJsxText(node) && containsEnglish(node.text)) {
        untranslatedJsx.push(
          `${sourceLocation(sourceFile, node)} ${JSON.stringify(node.text.replace(/\s+/g, " ").trim())}`,
        );
      }

      if (
        (
          ts.isStringLiteral(node) ||
          ts.isNoSubstitutionTemplateLiteral(node) ||
          ts.isTemplateExpression(node)
        ) &&
        (
          (
            ts.isConditionalExpression(node.parent) &&
            (node.parent.whenTrue === node || node.parent.whenFalse === node)
          ) ||
          (
            ts.isBinaryExpression(node.parent) &&
            node.parent.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
          )
        ) &&
        containsEnglish(
          ts.isTemplateExpression(node)
            ? [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join(" ")
            : node.text,
        )
      ) {
        const { jsxExpression, translated } = jsxExpressionAuditState(node);
        if (
          jsxExpression &&
          !translated &&
          !ts.isJsxAttribute(jsxExpression.parent)
        ) {
          untranslatedJsx.push(
            `${sourceLocation(sourceFile, node)} conditional=${JSON.stringify(node.getText(sourceFile))}`,
          );
        }
      }

      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "replaceAll"
      ) {
        const { jsxExpression, translated } = jsxExpressionAuditState(node);
        if (jsxExpression && !translated && !ts.isJsxAttribute(jsxExpression.parent)) {
          untranslatedJsx.push(
            `${sourceLocation(sourceFile, node)} untranslated dynamic label=${JSON.stringify(node.getText(sourceFile))}`,
          );
        }
      }

      if (
        ts.isJsxAttribute(node) &&
        VISIBLE_TEXT_ATTRIBUTES.has(node.name.getText(sourceFile)) &&
        node.initializer &&
        ts.isStringLiteral(node.initializer) &&
        containsEnglish(node.initializer.text)
      ) {
        untranslatedJsx.push(
          `${sourceLocation(sourceFile, node)} ${node.name.getText(sourceFile)}=${JSON.stringify(node.initializer.text)}`,
        );
      }

      if (
        ts.isJsxAttribute(node) &&
        VISIBLE_TEXT_ATTRIBUTES.has(node.name.getText(sourceFile)) &&
        node.initializer &&
        ts.isJsxExpression(node.initializer) &&
        node.initializer.expression &&
        ts.isTemplateExpression(node.initializer.expression)
      ) {
        const templateText = [
          node.initializer.expression.head.text,
          ...node.initializer.expression.templateSpans.map((span) => span.literal.text),
        ].join(" ");
        if (containsEnglish(templateText)) {
          untranslatedJsx.push(
            `${sourceLocation(sourceFile, node)} ${node.name.getText(sourceFile)} template=${JSON.stringify(templateText.trim())}`,
          );
        }
      }

      ts.forEachChild(node, visit);
    }

    visit(sourceFile);
  }

  return { missingTranslations, untranslatedJsx };
}

describe("admin Chinese locale completeness", () => {
  it("provides Chinese for every literal translation key", () => {
    expect(auditAdminTranslations().missingTranslations).toEqual([]);
  });

  it("routes every user-visible English JSX literal through i18n", () => {
    expect(auditAdminTranslations().untranslatedJsx).toEqual([]);
  });
});
