import { globSync, readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";

function source(path: string) {
  return readFileSync(path, "utf8");
}

const prismaModelDelegates = new Set(
  Array.from(
    source("prisma/schema.prisma").matchAll(/^model\s+([A-Za-z][A-Za-z0-9_]*)\s*\{/gm),
    ([, model]) => `${model[0]?.toLowerCase()}${model.slice(1)}`,
  ),
);

type StaticObject = {
  readonly properties: ReadonlyMap<string, ts.Expression | null>;
  readonly unknown: boolean;
};

type BindingKey = ts.Symbol | string;

type BindingInitializers = {
  readonly checker: ts.TypeChecker;
  readonly values: ReadonlyMap<BindingKey, ts.Expression | null>;
};

function bindingIdentifiers(name: ts.BindingName): ts.Identifier[] {
  if (ts.isIdentifier(name)) return [name];
  return name.elements.flatMap((element) =>
    ts.isOmittedExpression(element) ? [] : bindingIdentifiers(element.name)
  );
}

function bindingKey(identifier: ts.Identifier, bindings: Pick<BindingInitializers, "checker">): BindingKey {
  if (ts.isShorthandPropertyAssignment(identifier.parent) && identifier.parent.name === identifier) {
    const valueSymbol = bindings.checker.getShorthandAssignmentValueSymbol(identifier.parent);
    if (valueSymbol) return valueSymbol;
  }
  return bindings.checker.getSymbolAtLocation(identifier) ?? `unbound:${identifier.text}`;
}

function initializerFor(identifier: ts.Identifier, bindings: BindingInitializers) {
  return bindings.values.get(bindingKey(identifier, bindings));
}

function constInitializers(sourceFile: ts.SourceFile, checker: ts.TypeChecker): BindingInitializers {
  const initializers = new Map<BindingKey, ts.Expression | null>();
  const bindings = { checker, values: initializers } satisfies BindingInitializers;
  const register = (identifier: ts.Identifier, initializer: ts.Expression | null) => {
    const key = bindingKey(identifier, bindings);
    initializers.set(key, initializers.has(key) ? null : initializer);
  };
  const staticBindingPropertyName = (name: ts.PropertyName): string | null => {
    if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text;
    if (ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) return name.text;
    return null;
  };
  const registerBinding = (name: ts.BindingName, initializer: ts.Expression | null) => {
    if (ts.isIdentifier(name)) {
      register(name, initializer);
      return;
    }
    name.elements.forEach((element, index) => {
      if (ts.isOmittedExpression(element)) return;
      if (element.dotDotDotToken || element.initializer || !initializer) {
        for (const binding of bindingIdentifiers(element.name)) register(binding, null);
        return;
      }
      const property = ts.isObjectBindingPattern(name)
        ? element.propertyName
          ? staticBindingPropertyName(element.propertyName)
          : ts.isIdentifier(element.name)
            ? element.name.text
            : null
        : String(index);
      if (property === null) {
        for (const binding of bindingIdentifiers(element.name)) register(binding, null);
        return;
      }
      registerBinding(
        element.name,
        ts.factory.createElementAccessExpression(
          initializer,
          ts.factory.createStringLiteral(property),
        ),
      );
    });
  };
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node)) {
      const staticInitializer =
        node.initializer &&
        ts.isVariableDeclarationList(node.parent) &&
        (node.parent.flags & ts.NodeFlags.Const) !== 0
          ? node.initializer
          : null;
      registerBinding(node.name, staticInitializer);
    } else if (ts.isParameter(node)) {
      for (const name of bindingIdentifiers(node.name)) register(name, null);
    } else if (
      (ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isClassDeclaration(node) ||
        ts.isClassExpression(node) ||
        ts.isEnumDeclaration(node) ||
        ts.isImportEqualsDeclaration(node)) &&
      node.name
    ) {
      register(node.name, null);
    } else if (ts.isImportClause(node) && node.name) {
      register(node.name, null);
    } else if (ts.isImportSpecifier(node) || ts.isNamespaceImport(node)) {
      register(node.name, null);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return bindings;
}

function rootBinding(
  expression: ts.Expression,
  bindings: BindingInitializers,
): BindingKey | null {
  const current = unwrapExpression(expression);
  if (ts.isIdentifier(current)) return bindingKey(current, bindings);
  if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    return rootBinding(current.expression, bindings);
  }
  return null;
}

function mutatedBindings(
  sourceFile: ts.SourceFile,
  bindings: BindingInitializers,
  model: string,
  field: string,
) {
  const mutated = new Set<BindingKey>();
  const expandedEscapes = new Set<BindingKey>();
  const mark = (expression: ts.Expression) => {
    const root = rootBinding(expression, bindings);
    if (root) mutated.add(root);
  };
  const markEscaped = (expression: ts.Expression) => {
    const visitEscaped = (node: ts.Node, resolving: ReadonlySet<BindingKey>) => {
      if (ts.isIdentifier(node)) {
        const key = bindingKey(node, bindings);
        mutated.add(key);
        if (expandedEscapes.has(key)) return;
        expandedEscapes.add(key);
        const initializer = initializerFor(node, bindings);
        if (initializer && !resolving.has(key)) {
          visitEscaped(initializer, new Set([...resolving, key]));
        }
        return;
      }
      if (ts.isPropertyAccessExpression(node)) {
        visitEscaped(node.expression, resolving);
        return;
      }
      if (ts.isElementAccessExpression(node)) {
        visitEscaped(node.expression, resolving);
        if (node.argumentExpression) visitEscaped(node.argumentExpression, resolving);
        return;
      }
      if (ts.isPropertyAssignment(node)) {
        visitEscaped(node.initializer, resolving);
        return;
      }
      if (ts.isShorthandPropertyAssignment(node)) {
        visitEscaped(node.name, resolving);
        return;
      }
      if (ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) {
        if (node.body) visitEscaped(node.body, resolving);
        return;
      }
      if (ts.isBindingElement(node)) {
        if (node.initializer) visitEscaped(node.initializer, resolving);
        return;
      }
      if (ts.isVariableDeclaration(node) || ts.isParameter(node)) {
        if (node.initializer) visitEscaped(node.initializer, resolving);
        return;
      }
      if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)) {
        for (const parameter of node.parameters) {
          if (parameter.initializer) visitEscaped(parameter.initializer, resolving);
        }
        if (node.body) visitEscaped(node.body, resolving);
        return;
      }
      if (ts.isTypeNode(node)) return;
      ts.forEachChild(node, (child) => visitEscaped(child, resolving));
    };
    visitEscaped(expression, new Set());
  };
  const mutationCouldAffectField = (expression: ts.Expression) => {
    let current = unwrapExpression(expression);
    if (ts.isIdentifier(current)) return true;
    const path: Array<string | null> = [];
    while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
      if (ts.isPropertyAccessExpression(current)) {
        path.unshift(current.name.text);
        current = unwrapExpression(current.expression);
      } else {
        path.unshift(
          current.argumentExpression
            ? staticString(current.argumentExpression, bindings)
            : null,
        );
        current = unwrapExpression(current.expression);
      }
    }
    if (!ts.isIdentifier(current) || path.some((segment) => segment === null)) return true;
    return path[0] === field || path[0] === "data";
  };
  const markMutation = (expression: ts.Expression) => {
    if (mutationCouldAffectField(expression)) mark(expression);
  };
  const visit = (node: ts.Node) => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    ) {
      markMutation(node.left);
      if (ts.isIdentifier(unwrapExpression(node.left))) mark(node.right);
    } else if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)
    ) {
      markMutation(node.operand);
    } else if (
      ts.isDeleteExpression(node)
    ) {
      markMutation(node.expression);
    } else if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      ["Object", "Reflect"].includes(node.expression.expression.text) &&
      ["assign", "defineProperty", "set"].includes(node.expression.name.text) &&
      node.arguments[0]
    ) {
      mark(node.arguments[0]);
    } else if (
      ts.isCallExpression(node) &&
      !isPrismaMutationMethod(node.expression, bindings)
    ) {
      for (const argument of node.arguments) markEscaped(argument);
    } else if (ts.isNewExpression(node)) {
      for (const argument of node.arguments ?? []) markEscaped(argument);
    } else if (ts.isReturnStatement(node) && node.expression) {
      markEscaped(node.expression);
    } else if (ts.isYieldExpression(node) && node.expression) {
      markEscaped(node.expression);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  // A mutated alias mutates the same object as its const identifier source.
  // Propagate both directions until the alias group reaches a fixed point.
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, initializer] of bindings.values) {
      if (!initializer) continue;
      const root = rootBinding(initializer, bindings);
      if (!root) continue;
      if (mutated.has(name) && !mutated.has(root)) {
        mutated.add(root);
        changed = true;
      }
      if (mutated.has(root) && !mutated.has(name)) {
        mutated.add(name);
        changed = true;
      }
    }
  }
  return mutated;
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function staticString(
  expression: ts.Expression,
  bindings: BindingInitializers,
  resolving: ReadonlySet<BindingKey> = new Set(),
): string | null {
  const current = unwrapExpression(expression);
  if (ts.isStringLiteralLike(current)) return current.text;
  if (!ts.isIdentifier(current)) return null;
  const key = bindingKey(current, bindings);
  if (resolving.has(key)) return null;
  const initializer = initializerFor(current, bindings);
  if (!initializer) return null;
  return staticString(
    initializer,
    bindings,
    new Set([...resolving, key]),
  );
}

function staticPropertyName(
  name: ts.PropertyName,
  bindings: BindingInitializers,
) {
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text;
  if (ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) return name.text;
  if (ts.isComputedPropertyName(name)) {
    return staticString(name.expression, bindings);
  }
  return null;
}

function staticObject(
  expression: ts.Expression,
  bindings: BindingInitializers,
  mutated: ReadonlySet<BindingKey>,
  resolving: ReadonlySet<BindingKey> = new Set(),
): StaticObject | null {
  const current = unwrapExpression(expression);
  if (ts.isIdentifier(current)) {
    const key = bindingKey(current, bindings);
    if (resolving.has(key) || mutated.has(key)) return null;
    const initializer = initializerFor(current, bindings);
    if (!initializer) return null;
    return staticObject(
      initializer,
      bindings,
      mutated,
      new Set([...resolving, key]),
    );
  }
  if (!ts.isObjectLiteralExpression(current)) return null;

  const properties = new Map<string, ts.Expression | null>();
  let unknown = false;
  for (const property of current.properties) {
    if (ts.isSpreadAssignment(property)) {
      const spread = staticObject(property.expression, bindings, mutated, resolving);
      if (!spread) {
        unknown = true;
        continue;
      }
      unknown ||= spread.unknown;
      for (const [key, value] of spread.properties) properties.set(key, value);
      continue;
    }
    if (ts.isShorthandPropertyAssignment(property)) {
      properties.set(property.name.text, property.name);
      continue;
    }
    if (
      ts.isPropertyAssignment(property) ||
      ts.isMethodDeclaration(property) ||
      ts.isGetAccessorDeclaration(property) ||
      ts.isSetAccessorDeclaration(property)
    ) {
      const key = staticPropertyName(property.name, bindings);
      if (key === null) {
        unknown = true;
        continue;
      }
      properties.set(
        key,
        ts.isPropertyAssignment(property) ? property.initializer : null,
      );
      continue;
    }
    unknown = true;
  }
  return { properties, unknown };
}

function isModelDelegate(
  expression: ts.Expression,
  model: string,
  bindings: BindingInitializers,
  resolving: ReadonlySet<BindingKey> = new Set(),
): boolean {
  return staticModelDelegateName(expression, bindings, resolving) === model;
}

function staticModelDelegateName(
  expression: ts.Expression,
  bindings: BindingInitializers,
  resolving: ReadonlySet<BindingKey> = new Set(),
): string | null {
  const current = unwrapExpression(expression);
  if (ts.isPropertyAccessExpression(current)) {
    return current.name.text;
  }
  if (ts.isElementAccessExpression(current) && current.argumentExpression) {
    return staticString(current.argumentExpression, bindings);
  }
  if (!ts.isIdentifier(current)) return null;
  const key = bindingKey(current, bindings);
  if (resolving.has(key)) return null;
  const initializer = initializerFor(current, bindings);
  if (!initializer) return null;
  return staticModelDelegateName(
    initializer,
    bindings,
    new Set([...resolving, key]),
  );
}

function staticModelDelegateClient(
  expression: ts.Expression,
  bindings: BindingInitializers,
  resolving: ReadonlySet<BindingKey> = new Set(),
): ts.Expression | null {
  const current = unwrapExpression(expression);
  if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    return current.expression;
  }
  if (!ts.isIdentifier(current)) return null;
  const key = bindingKey(current, bindings);
  if (resolving.has(key)) return null;
  const initializer = initializerFor(current, bindings);
  if (!initializer) return null;
  return staticModelDelegateClient(
    initializer,
    bindings,
    new Set([...resolving, key]),
  );
}

function typeNodeProvesPrismaClient(
  node: ts.TypeNode,
  bindings: BindingInitializers,
  resolving: ReadonlySet<ts.Symbol> = new Set(),
): boolean {
  if (ts.isTypeReferenceNode(node)) {
    const text = node.typeName.getText();
    if (/\b(?:PrismaClient|TransactionClient)\b/.test(text)) return true;
    const symbol = bindings.checker.getSymbolAtLocation(node.typeName);
    if (!symbol || resolving.has(symbol)) return false;
    return symbol.declarations?.some((declaration) =>
      ts.isTypeAliasDeclaration(declaration) &&
      typeNodeProvesPrismaClient(
        declaration.type,
        bindings,
        new Set([...resolving, symbol]),
      )
    ) ?? false;
  }
  if (ts.isUnionTypeNode(node) || ts.isIntersectionTypeNode(node)) {
    return node.types.some((type) => typeNodeProvesPrismaClient(type, bindings, resolving));
  }
  if (ts.isTypeQueryNode(node)) {
    const value = node.exprName.getText();
    return value === "prisma" || value === "db";
  }
  return false;
}

function identifierImportsPrismaClient(
  identifier: ts.Identifier,
  bindings: BindingInitializers,
): boolean {
  const symbol = bindings.checker.getSymbolAtLocation(identifier);
  return symbol?.declarations?.some((specifier) => {
    if (!ts.isImportSpecifier(specifier)) return false;
    const declaration = ts.findAncestor(specifier, ts.isImportDeclaration);
    return declaration !== undefined &&
      ts.isStringLiteral(declaration.moduleSpecifier) &&
      /(?:^|\/)server\/lib\/db$/.test(declaration.moduleSpecifier.text);
  }) ?? false;
}

function identifierIsTransactionCallbackParameter(
  identifier: ts.Identifier,
  bindings: BindingInitializers,
  resolving: ReadonlySet<BindingKey>,
): boolean {
  const symbol = bindings.checker.getSymbolAtLocation(identifier);
  const parameter = symbol?.declarations?.find(ts.isParameter);
  if (!parameter || !ts.isIdentifier(parameter.name)) return false;
  const callback = parameter.parent;
  if (!ts.isFunctionExpression(callback) && !ts.isArrowFunction(callback)) return false;
  const transaction = callback.parent;
  if (!ts.isCallExpression(transaction) || !transaction.arguments.includes(callback)) return false;
  if (!ts.isPropertyAccessExpression(transaction.expression) || transaction.expression.name.text !== "$transaction") {
    return false;
  }
  return isKnownPrismaClient(
    transaction.expression.expression,
    bindings,
    resolving,
  );
}

function isKnownPrismaClient(
  expression: ts.Expression,
  bindings: BindingInitializers,
  resolving: ReadonlySet<BindingKey> = new Set(),
): boolean {
  const current = unwrapExpression(expression);
  const type = bindings.checker.getTypeAtLocation(current);
  const typeName = bindings.checker.typeToString(type);
  if (/\b(?:PrismaClient|TransactionClient)\b/.test(typeName)) return true;
  // Transaction callback clients are often rendered as Omit<PrismaClient,
  // ...>, not TransactionClient. Their generated delegate surface is the
  // stronger, structural proof we need here; `any`/`unknown` helpers expose
  // neither symbols nor this surface.
  if (bindings.checker.getPropertiesOfType(type).some((property) =>
    prismaModelDelegates.has(property.name)
  )) return true;
  if (ts.isIdentifier(current)) {
    // An unresolved top-level `db`/`prisma`/`tx` is the deliberately tiny
    // fixture-level spelling of a Prisma client. A same-named local binding is
    // not sufficient proof: it has to carry a Prisma client type or resolve
    // through a const alias to one. This is what makes shadowing fail closed.
    if (
      ["db", "prisma", "tx"].includes(current.text) &&
      !bindings.checker.getSymbolAtLocation(current)
    ) return true;
    if (identifierImportsPrismaClient(current, bindings)) return true;
    if (identifierIsTransactionCallbackParameter(current, bindings, resolving)) return true;
    const symbol = bindings.checker.getSymbolAtLocation(current);
    if (symbol?.declarations?.some((declaration) =>
      ts.isParameter(declaration) && declaration.type &&
      typeNodeProvesPrismaClient(declaration.type, bindings)
    )) return true;
    const key = bindingKey(current, bindings);
    if (resolving.has(key)) return false;
    const initializer = initializerFor(current, bindings);
    if (!initializer) return false;
    return isKnownPrismaClient(
      initializer,
      bindings,
      new Set([...resolving, key]),
    );
  }
  // `helper.prisma` or `service["db"]` is just a property with a familiar
  // name. Without a typed root it must not turn arbitrary helper delegates
  // into "pure" Prisma calls.
  return false;
}

function isKnownPrismaDelegate(
  expression: ts.Expression,
  bindings: BindingInitializers,
) {
  const model = staticModelDelegateName(expression, bindings);
  const client = staticModelDelegateClient(expression, bindings);
  return model !== null && prismaModelDelegates.has(model) && client !== null &&
    isKnownPrismaClient(client, bindings);
}

function isPrismaMutationMethod(
  expression: ts.Expression,
  bindings: BindingInitializers,
  resolving: ReadonlySet<BindingKey> = new Set(),
): boolean {
  const current = unwrapExpression(expression);
  if (ts.isPropertyAccessExpression(current)) {
    return ["update", "updateMany"].includes(current.name.text) &&
      isKnownPrismaDelegate(current.expression, bindings);
  }
  if (ts.isElementAccessExpression(current) && current.argumentExpression) {
    const method = staticString(current.argumentExpression, bindings);
    return (method === "update" || method === "updateMany") &&
      isKnownPrismaDelegate(current.expression, bindings);
  }
  if (!ts.isIdentifier(current)) return false;
  const key = bindingKey(current, bindings);
  if (resolving.has(key)) return false;
  const initializer = initializerFor(current, bindings);
  if (!initializer) return false;
  return isPrismaMutationMethod(
    initializer,
    bindings,
    new Set([...resolving, key]),
  );
}

function isModelMutationMethod(
  expression: ts.Expression,
  model: string,
  bindings: BindingInitializers,
  resolving: ReadonlySet<BindingKey> = new Set(),
): boolean {
  const current = unwrapExpression(expression);
  if (ts.isPropertyAccessExpression(current)) {
    return ["update", "updateMany"].includes(current.name.text) &&
      isModelDelegate(current.expression, model, bindings) &&
      isKnownPrismaDelegate(current.expression, bindings);
  }
  if (ts.isElementAccessExpression(current) && current.argumentExpression) {
    const method = staticString(current.argumentExpression, bindings);
    return (method === "update" || method === "updateMany") &&
      isModelDelegate(current.expression, model, bindings) &&
      isKnownPrismaDelegate(current.expression, bindings);
  }
  if (!ts.isIdentifier(current)) return false;
  const key = bindingKey(current, bindings);
  if (resolving.has(key)) return false;
  const initializer = initializerFor(current, bindings);
  if (!initializer) return false;
  return isModelMutationMethod(
    initializer,
    model,
    bindings,
    new Set([...resolving, key]),
  );
}

const parsedMutationSourceCache = new Map<string, {
  readonly sourceFile: ts.SourceFile;
  readonly bindings: BindingInitializers;
}>();

function parsedMutationSource(contents: string) {
  const cached = parsedMutationSourceCache.get(contents);
  if (cached) return cached;
  const fileName = "/detector-fixture.ts";
  const sourceFile = ts.createSourceFile(
    fileName,
    contents,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const compilerOptions: ts.CompilerOptions = {
    noLib: true,
    noResolve: true,
    target: ts.ScriptTarget.Latest,
  };
  const host = ts.createCompilerHost(compilerOptions, true);
  host.fileExists = (path) => path === fileName;
  host.readFile = (path) => path === fileName ? contents : undefined;
  host.getSourceFile = (path) => path === fileName ? sourceFile : undefined;
  host.getCurrentDirectory = () => "/";
  const program = ts.createProgram([fileName], compilerOptions, host);
  const boundSourceFile = program.getSourceFile(fileName);
  if (!boundSourceFile) throw new Error("Mutation detector source did not bind");
  const parsed = {
    sourceFile: boundSourceFile,
    bindings: constInitializers(boundSourceFile, program.getTypeChecker()),
  } as const;
  parsedMutationSourceCache.set(contents, parsed);
  return parsed;
}

function mutationSourceTargetsModel(contents: string, model: string) {
  const { sourceFile, bindings } = parsedMutationSource(contents);
  let targetsModel = false;
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      isModelMutationMethod(node.expression, model, bindings)
    ) {
      targetsModel = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return targetsModel;
}

function mutationSourceWritesField(
  contents: string,
  model: string,
  field: string,
) {
  const { sourceFile, bindings } = parsedMutationSource(contents);
  const mutated = mutatedBindings(sourceFile, bindings, model, field);
  let writesField = false;

  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      isModelMutationMethod(node.expression, model, bindings)
    ) {
      const input = node.arguments[0];
      const staticInput = input ? staticObject(input, bindings, mutated) : null;
      if (!staticInput || staticInput.unknown) {
        writesField = true;
      } else if (staticInput.properties.has("data")) {
        const data = staticInput.properties.get("data");
        const staticData = data ? staticObject(data, bindings, mutated) : null;
        if (
          !staticData ||
          staticData.unknown ||
          staticData.properties.has(field)
        ) writesField = true;
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return writesField;
}

function mutationWritesField(path: string, model: string, field: string) {
  return mutationSourceWritesField(source(path), model, field);
}

function mutationTargetsModel(path: string, model: string) {
  return mutationSourceTargetsModel(source(path), model);
}

const productionTypeScript = globSync("src/**/*.ts")
  .filter((path) =>
    !path.endsWith(".test.ts") &&
    !path.endsWith(".integration.test.ts") &&
    !path.endsWith(".e2e.ts"),
  );

describe("Admin v2 finite-state authority inventory", () => {
  describe("mutation writer detector", () => {
    const writesCreativeItemStatus = (contents: string) =>
      mutationSourceWritesField(contents, "contentProductionItem", "status");

    it.each([
      {
        name: "direct inline data",
        source: 'db.contentProductionItem.update({ where: { id: "item" }, data: { status: "approved" } });',
      },
      {
        name: "data variable",
        source: 'const data = { status: "approved" }; db.contentProductionItem.update({ where: { id: "item" }, data });',
      },
      {
        name: "whole input variable",
        source: 'const input = { where: { id: "item" }, data: { status: "approved" } }; db.contentProductionItem.update(input);',
      },
      {
        name: "known object spreads",
        source: 'const state = { status: "approved" }; const input = { where: { id: "item" }, data: { ...state } }; db.contentProductionItem.update({ ...input });',
      },
      {
        name: "string property key",
        source: 'db.contentProductionItem.update({ where: { id: "item" }, data: { "status": "approved" } });',
      },
      {
        name: "computed property key",
        source: 'const field = "status"; db.contentProductionItem.update({ where: { id: "item" }, data: { [field]: "approved" } });',
      },
    ])("detects $name", ({ source: contents }) => {
      expect(writesCreativeItemStatus(contents)).toBe(true);
    });

    it.each([
      'const data = buildPatch(); db.contentProductionItem.update({ where: { id: "item" }, data });',
      'db.contentProductionItem.update(buildInput());',
      'const key = getField(); db.contentProductionItem.update({ where: { id: "item" }, data: { [key]: "approved" } });',
      'const data = { jobId: "job" }; function write(data: unknown) { db.contentProductionItem.update({ where: { id: "item" }, data }); }',
    ])("fails closed for an unresolved dynamic update: %s", (contents) => {
      expect(writesCreativeItemStatus(contents)).toBe(true);
    });

    it.each([
      'db.contentProductionItem.update({ where: { id: "item" }, data: { jobId: "job" } });',
      'const data = { tags: ["search"] }; db.contentProductionItem.update({ where: { id: "item" }, data });',
      'const input = { where: { id: "item" }, data: { version: { increment: 1 } } }; db.contentProductionItem.update(input);',
    ])("does not report a statically proven metadata-only update: %s", (contents) => {
      expect(writesCreativeItemStatus(contents)).toBe(false);
    });

    it("detects a later state write after a metadata-only update in the same source", () => {
      expect(mutationSourceWritesField(
        'db.generationJob.update({ data: { jobId: "job" } }); db.generationJob.update({ data: { status: "failed" } });',
        "generationJob",
        "status",
      )).toBe(true);
    });

    it.each([
      'const jobs = db.generationJob; jobs.update({ data: { status: "failed" } });',
      'const jobs = db["generationJob"]; jobs["updateMany"]({ data: { status: "failed" } });',
      'const updateJob = db.generationJob.update; updateJob({ data: { status: "failed" } });',
      'const { generationJob: jobs } = db; jobs.update({ data: { status: "failed" } });',
      'const { update: updateJob } = db.generationJob; updateJob({ data: { status: "failed" } });',
      'const data = { jobId: "job" }; data.status = "failed"; db.generationJob.update({ data });',
      'const data = { jobId: "job" }; const patch = data; patch.status = "failed"; db.generationJob.update({ data });',
      'const data = { jobId: "job" }; mutate(data); db.generationJob.update({ data });',
      'const data = { jobId: "job" }; mutate({ payload: data }); db.generationJob.update({ data });',
      'const data = { jobId: "job" }; const envelope = { payload: data }; mutate(envelope); db.generationJob.update({ data });',
      'const data = { jobId: "job" }; const envelope = { payload: data }; mutate(envelope.payload); db.generationJob.update({ data });',
      'const data = { jobId: "job" }; helper.pipeline.update(data); db.generationJob.update({ data });',
      'const data = { jobId: "job" }; helper.generationJob.update(data); db.generationJob.update({ data });',
      'const data = { jobId: "job" }; new Wrapper([data]); db.generationJob.update({ data });',
      'const input = { data: { jobId: "job" } }; input["data"] = dynamicData(); db.generationJob.update(input);',
    ])("fails closed for model aliases and later data mutation: %s", (contents) => {
      expect(mutationSourceTargetsModel(contents, "generationJob")).toBe(true);
      expect(mutationSourceWritesField(contents, "generationJob", "status")).toBe(true);
    });

    it("keeps a statically proven metadata-only model alias out of the status inventory", () => {
      const contents = 'const jobs = db.generationJob; const data = { jobId: "job" }; jobs.update({ data });';
      expect(mutationSourceTargetsModel(contents, "generationJob")).toBe(true);
      expect(mutationSourceWritesField(contents, "generationJob", "status")).toBe(false);
    });

    it("treats known Prisma mutations as pure consumers of a shared metadata patch", () => {
      const contents = 'const data = { jobId: "job" }; db.adminCase.update({ data }); db.generationJob.update({ data });';
      expect(mutationSourceWritesField(contents, "generationJob", "status")).toBe(false);
    });

    it("does not infer a Prisma client from a helper property name", () => {
      const contents = 'const data = { jobId: "job" }; helper.prisma.generationJob.update(data); db.generationJob.update({ data });';
      expect(mutationSourceTargetsModel('helper.prisma.generationJob.update({ data: {} });', "generationJob")).toBe(false);
      expect(mutationSourceWritesField(contents, "generationJob", "status")).toBe(true);
    });

    it("does not treat a same-named parameter as a Prisma client", () => {
      const contents = 'function write(db: unknown) { const data = { jobId: "job" }; db.generationJob.update(data); }';
      expect(mutationSourceTargetsModel(contents, "generationJob")).toBe(false);
    });

    it("resolves same-named model aliases by lexical binding instead of file-wide text", () => {
      const contents = [
        'function writeJob() { const jobs = db.generationJob; jobs.update({ data: { status: "failed" } }); }',
        'function writeCase() { const jobs = db.adminCase; jobs.update({ data: { status: "closed" } }); }',
      ].join("\n");
      expect(mutationSourceTargetsModel(contents, "generationJob")).toBe(true);
      expect(mutationSourceWritesField(contents, "generationJob", "status")).toBe(true);
    });

    it("keeps a statically proven unrelated property mutation out of the status inventory", () => {
      const contents = 'const data = { jobId: "job" }; data.jobId = "job-2"; db.generationJob.update({ data });';
      expect(mutationSourceWritesField(contents, "generationJob", "status")).toBe(false);
    });
  });

  it("funnels every Generation Request status mutation through one versioned from-state CAS authority", () => {
    const directWriters = productionTypeScript.filter((path) =>
      mutationTargetsModel(path, "generationJob"),
    );
    expect(directWriters.sort()).toEqual([
      "src/server/ai/generation-request-transition.ts",
      "src/server/modules/admin-v2/generation/dead-letter.ts",
    ]);
    const statusWriters = productionTypeScript.filter((path) =>
      mutationWritesField(path, "generationJob", "status"),
    );
    expect(statusWriters).toEqual([
      "src/server/ai/generation-request-transition.ts",
    ]);

    const authority = source("src/server/ai/generation-request-transition.ts");
    expect(authority).toContain("isGenerationRequestTransitionAllowed");
    expect(authority).toContain("status: current.status");
    expect(authority).toContain("version: current.version");
    expect(authority).toContain("version: { increment: 1 }");

    expect(mutationWritesField(
      "src/server/modules/admin-v2/generation/dead-letter.ts",
      "generationJob",
      "status",
    )).toBe(false);
  });

  it("binds every Character Project phase writer to the phase authority", () => {
    const writers = productionTypeScript.filter((path) =>
      mutationWritesField(path, "characterProject", "phase"),
    );
    expect(writers.sort()).toEqual([
      "src/server/modules/admin-v2/characters/transition.ts",
    ]);
    for (const path of writers) {
      expect(source(path), path).toContain("isCharacterProjectPhaseTransitionAllowed");
    }
  });

  it("binds every Creative Run workflow or verification writer to both independent authorities", () => {
    const writers = productionTypeScript.filter((path) =>
      mutationWritesField(path, "contentProductionBatch", "workflowStage") ||
      mutationWritesField(path, "contentProductionBatch", "verificationState"),
    );
    expect(writers.sort()).toEqual([
      "src/server/modules/admin-v2/creative/placement.ts",
      "src/server/modules/admin-v2/creative/retry-executor.ts",
      "src/server/modules/admin-v2/creative/review-decision.ts",
    ]);
    for (const path of writers) {
      expect(source(path), path).toContain("isCreativeRunWorkflowTransitionAllowed");
      expect(source(path), path).toContain("isCreativeRunVerificationTransitionAllowed");
    }
  });

  /**
   * SPEC: 谁能写 MediaAssetPlacement —— 断言的是写者**集合**，不是某个符号名。
   * INTENT: 投放的三个动作原先与评审、读投影同住一个文件，「哪些代码能改一条已上线投放」
   * 要逐函数确认；拆开之后可以直接钉住集合。legacy 内容库 admin/content/placements.ts
   * 服务的是非 Creative 来源的素材投放，是名单里的第二条；多出第三条就是新的漂移。
   *
   * 这里用文本扫描而不是 mutationWritesField：那个 AST 检测器要能解析出 Prisma client
   * 的来源，而 legacy 那侧的事务是 `auditedTransaction("...", async (tx) => …)` 这种自定义
   * 包装，tx 解析不出来 —— 它对整个 legacy 文件是隐形的。用 AST 检测器写这条守卫会得到
   * 一个「只有一个写者」的假绿。
   */
  it("keeps MediaAssetPlacement writes to a known set of authorities", () => {
    const mutation = /mediaAssetPlacement\s*\.\s*(create|createMany|update|updateMany|upsert|delete|deleteMany)\s*\(/;
    // src/server/test 是 fixture 播种，不是写权威。
    const scanned = productionTypeScript.filter((path) => !path.startsWith("src/server/test/"));
    // 自检：目录改名后静默扫成空集合再全绿，比没有守卫更糟。
    expect(scanned.length).toBeGreaterThan(200);
    expect(scanned).toContain("src/server/modules/admin-v2/creative/placement.ts");

    const writers = scanned.filter((path) => mutation.test(source(path)));
    expect(writers.sort()).toEqual([
      "src/server/modules/admin-v2/content/placements.ts",
      "src/server/modules/admin-v2/creative/placement.ts",
    ]);
    expect(source("src/server/modules/admin-v2/creative/placement.ts")).toContain(
      "isCreativePlacementVerificationTransitionAllowed",
    );
  });

  it("binds every Creative item status writer to authority-checked versioned CAS", () => {
    const writers = productionTypeScript.filter((path) =>
      mutationWritesField(path, "contentProductionItem", "status"),
    );
    expect(writers.sort()).toEqual([
      "src/server/modules/admin-v2/creative/placement.ts",
      "src/server/modules/admin-v2/creative/retry-executor.ts",
      "src/server/modules/admin-v2/creative/review-decision.ts",
      "src/server/modules/content-production-state.ts",
    ]);
    for (const path of writers) {
      const contents = source(path);
      expect(contents, path).toContain("isCreativeRunItemTransitionAllowed");
      expect(contents, path).toContain("contentProductionItem.updateMany");
      expect(contents, path).toContain("version:");
    }
  });

  it("funnels every ControlPlaneCommandAttempt mutation through one CAS authority", () => {
    const directWriters = productionTypeScript.filter((path) =>
      mutationTargetsModel(path, "controlPlaneCommandAttempt"),
    );
    expect(directWriters).toEqual([
      "src/server/modules/admin-v2/shared/control-plane-command-attempt.ts",
    ]);
    const authority = source(directWriters[0]);
    expect(authority).toContain("isControlPlaneCommandAttemptTransitionAllowed");
    expect(authority).toContain("status: current.status");
  });

  it("funnels every ControlPlaneCommand transition through one CAS authority", () => {
    const directWriters = productionTypeScript.filter((path) =>
      /controlPlaneCommand\.(?:update|updateMany)\(/.test(source(path)),
    );
    expect(directWriters).toEqual([
      "src/server/modules/admin-v2/shared/control-plane-command-transition.ts",
    ]);
    const authority = source(directWriters[0]);
    expect(authority).toContain("isControlPlaneCommandTransitionAllowed");
    expect(authority).toContain("status: current.status");
  });

  it("funnels Incident, Case, Experiment, Release, and Serving transitions through aggregate owners", () => {
    const ownedAxes = [
      ["opsIncident", "status", "src/server/modules/admin-v2/incidents/transition.ts"],
      ["adminCase", "status", "src/server/modules/admin-v2/cases/transition.ts"],
      ["experimentDefinition", "status", "src/server/modules/admin-v2/experiments/transition.ts"],
      ["characterRelease", "status", "src/server/modules/admin-v2/characters/transition.ts"],
      ["characterServing", "state", "src/server/modules/admin-v2/characters/transition.ts"],
    ] as const;

    for (const [model, field, owner] of ownedAxes) {
      const writers = productionTypeScript
        .filter((path) => path !== "src/server/modules/admin-v2/characters/backfill.ts")
        .filter((path) => mutationWritesField(path, model, field));
      expect(writers, `${model}.${field}`).toEqual([owner]);
    }
  }, 15_000);

  it("excludes Creative execution, review, and deployment views because they are derived and not persisted axes", () => {
    const schema = source("prisma/schema.prisma");
    const batch = schema.match(/model ContentProductionBatch \{([\s\S]*?)\n\}/)?.[1];
    expect(batch).toBeDefined();
    expect(batch).not.toMatch(/\bexecutionOutcome\b/);
    expect(batch).not.toMatch(/\breviewState\b/);
    expect(batch).not.toMatch(/\bdeploymentState\b/);
    const derivation = source("src/server/modules/content-production-state.ts");
    expect(derivation).toContain("reviewState");
    expect(derivation).toContain("deploymentState");
    expect(derivation).toContain("executionOutcome");
  });
});
