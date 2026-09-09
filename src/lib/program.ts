import path from "node:path";

import ts from "typescript";

export function createBackendProgram(target: string, files: string[], typesFile: string): ts.Program {
  const configPath = ts.findConfigFile(target, ts.sys.fileExists, "tsconfig.json");
  const rootNames = [...new Set([...files, typesFile])];
  if (!configPath) {
    return ts.createProgram({
      rootNames,
      options: {
        noEmit: true,
        skipLibCheck: true,
        strict: true,
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
        moduleResolution: ts.ModuleResolutionKind.Node10,
        esModuleInterop: true,
      },
    });
  }
  const { config, error } = ts.readConfigFile(configPath, ts.sys.readFile);
  if (error) {
    throw new Error(ts.flattenDiagnosticMessageText(error.messageText, "\n"));
  }
  const parsed = ts.parseJsonConfigFileContent(config, ts.sys, path.dirname(configPath));
  return ts.createProgram({
    rootNames: [...new Set([...parsed.fileNames, ...rootNames])],
    options: {
      ...parsed.options,
      noEmit: true,
      skipLibCheck: true,
    },
  });
}

export function stringLiteralsFromType(type: ts.Type): string[] | null {
  if (type.isStringLiteral()) return [type.value];
  if (type.isUnion()) {
    const lits: string[] = [];
    for (const t of type.types) {
      if (!t.isStringLiteral()) return null;
      lits.push(t.value);
    }
    return lits.length ? lits : null;
  }
  return null;
}

export function stringFromType(checker: ts.TypeChecker, node: ts.Node): string | null {
  const lits = stringLiteralsFromType(checker.getTypeAtLocation(node));
  return lits?.length === 1 ? lits[0] : null;
}

const OBJECT_PROTO = new Set([
  "constructor",
  "toString",
  "toLocaleString",
  "valueOf",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
]);

export function propertyNamesFromType(checker: ts.TypeChecker, node: ts.Node): string[] | null {
  const type = checker.getTypeAtLocation(node);
  const flags = type.getFlags();
  if (flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never)) return null;
  if (type.getStringIndexType() && type.getProperties().length === 0) return null;
  const names = type.getProperties()
    .map((p) => p.getName())
    .filter((n) => n && !n.startsWith("__") && !OBJECT_PROTO.has(n));
  return names.length ? names : null;
}

export function calleeFunction(call: ts.CallExpression, checker: ts.TypeChecker): ts.FunctionLikeDeclaration | undefined {
  const expr = call.expression;
  const target = ts.isPropertyAccessExpression(expr) ? expr.name : expr;
  const symbol = checker.getSymbolAtLocation(target) ?? checker.getSymbolAtLocation(expr);
  if (!symbol) return undefined;
  return functionFromSymbol(symbol, checker, new Set());
}

function functionFromSymbol(
  symbol: ts.Symbol,
  checker: ts.TypeChecker,
  seen: Set<ts.Symbol>,
): ts.FunctionLikeDeclaration | undefined {
  if (seen.has(symbol)) return undefined;
  seen.add(symbol);
  let resolved = symbol;
  if (resolved.flags & ts.SymbolFlags.Alias) {
    resolved = checker.getAliasedSymbol(resolved);
  }
  for (const decl of resolved.getDeclarations() ?? []) {
    if (
      ts.isFunctionDeclaration(decl)
      || ts.isMethodDeclaration(decl)
      || ts.isFunctionExpression(decl)
      || ts.isArrowFunction(decl)
    ) {
      return decl;
    }
    if (ts.isVariableDeclaration(decl) && decl.initializer) {
      const init = unwrapInit(decl.initializer);
      if (ts.isFunctionExpression(init) || ts.isArrowFunction(init)) return init;
    }
    if (ts.isShorthandPropertyAssignment(decl)) {
      const value = checker.getShorthandAssignmentValueSymbol(decl);
      if (value) {
        const fn = functionFromSymbol(value, checker, seen);
        if (fn) return fn;
      }
    }
    if (ts.isPropertyAssignment(decl)) {
      const init = unwrapInit(decl.initializer);
      if (ts.isFunctionExpression(init) || ts.isArrowFunction(init)) return init;
      if (ts.isIdentifier(init)) {
        const value = checker.getSymbolAtLocation(init);
        if (value) {
          const fn = functionFromSymbol(value, checker, seen);
          if (fn) return fn;
        }
      }
    }
  }
  return undefined;
}

function unwrapInit(expr: ts.Expression): ts.Expression {
  let current = expr;
  while (
    ts.isParenthesizedExpression(current)
    || ts.isAsExpression(current)
    || ts.isTypeAssertionExpression(current)
    || ts.isSatisfiesExpression(current)
    || ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}
