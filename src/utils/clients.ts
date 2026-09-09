import ts from "typescript";

import { chainProps, chainRoot, unwrapExpr } from "./ast";
import { QUERY_METHODS, SKIP_CHAIN_PROPS } from "./paths";

/** Official / common factories that return a Supabase client. */
const CLIENT_FACTORIES = new Set([
  "createClient",
  "createBrowserClient",
  "createServerClient",
  "createTypedClient",
  "createServerComponentClient",
  "createClientComponentClient",
  "createRouteHandlerClient",
  "createMiddlewareClient",
  "createServiceRoleClient",
]);

const CLIENT_TYPE_NAME = /SupabaseClient/;

export function factoryName(expr: ts.Expression): string | null {
  const node = unwrapExpr(expr);
  if (!ts.isCallExpression(node)) return null;
  const callee = unwrapExpr(node.expression);
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return null;
}

export function isClientFactoryCall(expr: ts.Expression): boolean {
  const name = factoryName(expr);
  return name != null && CLIENT_FACTORIES.has(name);
}

export function isSupabaseClientType(checker: ts.TypeChecker, type: ts.Type, seen = new Set<ts.Type>()): boolean {
  if (seen.has(type)) return false;
  seen.add(type);

  if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never | ts.TypeFlags.Null | ts.TypeFlags.Undefined)) {
    return false;
  }

  if (type.isUnionOrIntersection()) {
    return type.types.some((t) => isSupabaseClientType(checker, t, seen));
  }

  const apparent = checker.getApparentType(type);
  if (apparent !== type && isSupabaseClientType(checker, apparent, seen)) return true;

  const symbolName = type.aliasSymbol?.getName() ?? type.getSymbol()?.getName() ?? "";
  if (CLIENT_TYPE_NAME.test(symbolName)) return true;

  const props = new Set(apparent.getProperties().map((p) => p.getName()));
  return props.has("from") && (props.has("rpc") || (props.has("schema") && props.has("auth")));
}

export function exprLooksLikeClient(checker: ts.TypeChecker, expr: ts.Expression): boolean {
  if (isClientFactoryCall(expr)) return true;
  return isSupabaseClientType(checker, checker.getTypeAtLocation(expr));
}

function bindingName(name: ts.BindingName | ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return null;
}

function shouldKeepName(name: string): boolean {
  return !QUERY_METHODS.has(name) && !SKIP_CHAIN_PROPS.has(name) && name !== "from";
}

/**
 * Discover identifiers that hold a Supabase client: factory calls
 * (`createClient`, `createBrowserClient`, …) and values typed as `SupabaseClient`.
 */
export function collectClientNames(program: ts.Program, checker: ts.TypeChecker): Set<string> {
  const names = new Set<string>();

  const add = (name: string | null): void => {
    if (name && shouldKeepName(name)) names.add(name);
  };

  const consider = (name: string | null, node: ts.Node, init?: ts.Expression): void => {
    if (!name) return;
    if (init && isClientFactoryCall(init)) {
      add(name);
      return;
    }
    if (isSupabaseClientType(checker, checker.getTypeAtLocation(node))) add(name);
  };

  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile || sf.fileName.includes("node_modules")) continue;

    const visit = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
        consider(node.name.text, node.name, node.initializer);
      } else if (ts.isPropertyAssignment(node)) {
        consider(bindingName(node.name), node.name, node.initializer);
      } else if (ts.isShorthandPropertyAssignment(node)) {
        consider(node.name.text, node.name);
      } else if (ts.isImportSpecifier(node)) {
        consider(node.name.text, node.name);
      } else if (ts.isFunctionDeclaration(node) && node.name) {
        const sig = checker.getTypeAtLocation(node);
        const ret = sig.getCallSignatures()[0]?.getReturnType();
        if (ret && isSupabaseClientType(checker, ret)) add(node.name.text);
      }

      ts.forEachChild(node, visit);
    };
    visit(sf);
  }

  return names;
}

export function looksLikeClient(
  tail: ts.CallExpression,
  opts?: { checker?: ts.TypeChecker; names?: Set<string> },
): boolean {
  const props = chainProps(tail.expression);
  if (props.some((n) => CLIENT_FACTORIES.has(n))) return true;
  if (opts?.names && props.some((n) => opts.names!.has(n))) return true;
  if (opts?.checker) {
    const root = chainRoot(tail);
    if (root && exprLooksLikeClient(opts.checker, root)) return true;
  }
  return false;
}
