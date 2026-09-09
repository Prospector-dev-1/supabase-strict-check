import ts from "typescript";

import { stringLiteralsFromType } from "../lib/program";
import type { MethodCall } from "../lib/types";
import { CLIENT_NAMES, QUERY_METHODS } from "./paths";

export function loc(sf: ts.SourceFile, node: ts.Node): { line: number; column: number } {
  const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
  return { line: line + 1, column: character + 1 };
}

export function propName(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return null;
}

export function unwrapExpr(expr: ts.Expression): ts.Expression {
  let current = expr;
  for (;;) {
    if (ts.isParenthesizedExpression(current)) {
      current = current.expression;
      continue;
    }
    if (ts.isAsExpression(current) || ts.isTypeAssertionExpression(current) || ts.isSatisfiesExpression(current)) {
      current = current.expression;
      continue;
    }
    if (ts.isNonNullExpression(current)) {
      current = current.expression;
      continue;
    }
    return current;
  }
}

export function evalString(
  expr: ts.Expression,
  consts: Map<string, string>,
  opts?: { checker?: ts.TypeChecker; subst?: Map<string, string> },
): string | null {
  const node = unwrapExpr(expr);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = evalString(node.left, consts, opts);
    const right = evalString(node.right, consts, opts);
    if (left != null && right != null) return left + right;
    return null;
  }
  if (ts.isTemplateExpression(node)) {
    let out = node.head.text;
    for (const span of node.templateSpans) {
      const inner = evalString(span.expression, consts, opts);
      if (inner == null) return null;
      out += inner + span.literal.text;
    }
    return out;
  }
  if (ts.isIdentifier(node)) {
    if (opts?.subst?.has(node.text)) return opts.subst.get(node.text) ?? null;
    if (consts.has(node.text)) return consts.get(node.text) ?? null;
    if (opts?.checker) {
      const lits = stringLiteralsFromType(opts.checker.getTypeAtLocation(node));
      if (lits?.length === 1) return lits[0];
    }
    return null;
  }
  if (opts?.checker) {
    const lits = stringLiteralsFromType(opts.checker.getTypeAtLocation(node));
    if (lits?.length === 1) return lits[0];
  }
  return null;
}

/** All string-literal possibilities (unions / `a ? "id" : "slug"`). */
export function evalStrings(
  expr: ts.Expression,
  consts: Map<string, string>,
  opts?: { checker?: ts.TypeChecker; subst?: Map<string, string> },
): string[] | null {
  const one = evalString(expr, consts, opts);
  if (one != null) return [one];
  const node = unwrapExpr(expr);
  if (ts.isConditionalExpression(node)) {
    const left = evalStrings(node.whenTrue, consts, opts);
    const right = evalStrings(node.whenFalse, consts, opts);
    if (left && right) return [...left, ...right];
  }
  if (opts?.checker) {
    return stringLiteralsFromType(opts.checker.getTypeAtLocation(node));
  }
  return null;
}

export function stringish(
  expr: ts.Expression,
  consts: Map<string, string>,
  opts?: { checker?: ts.TypeChecker; subst?: Map<string, string> },
): { text: string; complete: boolean } | null {
  const complete = evalString(expr, consts, opts);
  if (complete != null) return { text: complete, complete: true };

  const node = unwrapExpr(expr);
  if (ts.isTemplateExpression(node)) {
    let out = node.head.text;
    for (const span of node.templateSpans) {
      const inner = evalString(span.expression, consts, opts);
      out += (inner ?? "") + span.literal.text;
    }
    return { text: out, complete: false };
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = stringish(node.left, consts, opts);
    const right = stringish(node.right, consts, opts);
    if (!left || !right) return null;
    return { text: left.text + right.text, complete: left.complete && right.complete };
  }
  return null;
}

export function bindingHasIdent(name: ts.BindingName, ident: string): boolean {
  if (ts.isIdentifier(name)) return name.text === ident;
  if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
    return name.elements.some((el) => {
      if (ts.isOmittedExpression(el)) return false;
      return bindingHasIdent(el.name, ident);
    });
  }
  return false;
}

export function enclosingParam(ident: ts.Identifier): { fn: ts.FunctionLikeDeclaration; index: number } | null {
  let current: ts.Node | undefined = ident.parent;
  while (current) {
    if (ts.isFunctionLike(current) && "body" in current) {
      const fn = current as ts.FunctionLikeDeclaration;
      const index = fn.parameters.findIndex((p) => bindingHasIdent(p.name, ident.text));
      if (index >= 0) return { fn, index };
    }
    current = current.parent;
  }
  return null;
}

export function isParameterIdentifier(ident: ts.Identifier): boolean {
  return enclosingParam(ident) != null;
}

export function callReceiver(call: ts.CallExpression): ts.Expression | undefined {
  if (ts.isPropertyAccessExpression(call.expression)) return call.expression.expression;
  if (ts.isIdentifier(call.expression)) return call.expression;
  return undefined;
}

export function isArrayFrom(fromCall: MethodCall): boolean {
  const receiver = callReceiver(fromCall.node);
  return Boolean(receiver && ts.isIdentifier(receiver) && receiver.text === "Array");
}

export function chainProps(expr: ts.Expression): string[] {
  const names: string[] = [];
  let current: ts.Expression | undefined = expr;
  while (current) {
    if (ts.isCallExpression(current)) {
      current = current.expression as ts.Expression;
      continue;
    }
    if (ts.isPropertyAccessExpression(current)) {
      names.push(current.name.text);
      current = current.expression;
      continue;
    }
    if (ts.isIdentifier(current)) {
      names.push(current.text);
      break;
    }
    if (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isNonNullExpression(current)) {
      current = current.expression;
      continue;
    }
    break;
  }
  return names;
}

export function collectChain(tail: ts.CallExpression): MethodCall[] {
  const methods: MethodCall[] = [];
  let current: ts.Expression | undefined = tail;
  while (current && ts.isCallExpression(current)) {
    if (ts.isPropertyAccessExpression(current.expression)) {
      const name = current.expression.name.text;
      if (!QUERY_METHODS.has(name)) break;
      methods.push({
        name,
        args: [...current.arguments] as ts.Expression[],
        node: current,
      });
      current = current.expression.expression;
      continue;
    }
    break;
  }
  methods.reverse();
  return methods;
}

export function chainRoot(tail: ts.CallExpression): ts.Expression | undefined {
  let current: ts.Expression | undefined = tail;
  while (current && ts.isCallExpression(current)) {
    if (ts.isPropertyAccessExpression(current.expression)) {
      const name = current.expression.name.text;
      if (!QUERY_METHODS.has(name)) break;
      current = current.expression.expression;
      continue;
    }
    break;
  }
  return current ? unwrapExpr(current) : undefined;
}

export function isChainTail(node: ts.CallExpression): boolean {
  const parent = node.parent;
  if (
    ts.isPropertyAccessExpression(parent)
    && ts.isCallExpression(parent.parent)
    && parent.parent.expression === parent
    && QUERY_METHODS.has(parent.name.text)
  ) {
    return false;
  }
  return true;
}

export function looksLikeClient(tail: ts.CallExpression): boolean {
  return chainProps(tail.expression).some((n) => CLIENT_NAMES.has(n));
}

export function assignedName(tail: ts.CallExpression): string | null {
  let current: ts.Node = tail;
  while (
    ts.isAsExpression(current.parent)
    || ts.isParenthesizedExpression(current.parent)
    || ts.isSatisfiesExpression(current.parent)
    || ts.isNonNullExpression(current.parent)
    || ts.isAwaitExpression(current.parent)
  ) {
    current = current.parent;
  }
  const parent = current.parent;
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
    return parent.name.text;
  }
  if (
    ts.isBinaryExpression(parent)
    && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
    && ts.isIdentifier(parent.left)
  ) {
    return parent.left.text;
  }
  return null;
}

export function objectLiteral(expr: ts.Expression | undefined): ts.ObjectLiteralExpression | null {
  if (!expr) return null;
  const node = unwrapExpr(expr);
  return ts.isObjectLiteralExpression(node) ? node : null;
}

export function objectKeys(expr: ts.Expression | undefined): { keys: string[]; hasSpread: boolean } | null {
  const obj = objectLiteral(expr);
  if (!obj) {
    const node = expr ? unwrapExpr(expr) : null;
    if (node && ts.isArrayLiteralExpression(node)) {
      const keys = new Set<string>();
      let hasSpread = false;
      let anyObj = false;
      for (const el of node.elements) {
        const parsed = objectKeys(el);
        if (!parsed) continue;
        anyObj = true;
        parsed.keys.forEach((k) => keys.add(k));
        hasSpread = hasSpread || parsed.hasSpread;
      }
      return anyObj ? { keys: [...keys], hasSpread } : null;
    }
    return null;
  }
  const keys: string[] = [];
  let hasSpread = false;
  for (const prop of obj.properties) {
    if (ts.isSpreadAssignment(prop)) {
      hasSpread = true;
      continue;
    }
    if (ts.isPropertyAssignment(prop) || ts.isShorthandPropertyAssignment(prop)) {
      const name = propName(prop.name);
      if (name) keys.push(name);
    }
  }
  return { keys, hasSpread };
}

export function optionString(
  args: ts.Expression[],
  options: string[],
  consts: Map<string, string>,
  opts?: { checker?: ts.TypeChecker; subst?: Map<string, string> },
): string | null {
  const obj = args.length >= 2 ? objectLiteral(args[1]) : null;
  if (!obj) return null;
  for (const prop of obj.properties) {
    if (!ts.isPropertyAssignment(prop)) continue;
    const key = propName(prop.name);
    if (!key || !options.includes(key)) continue;
    return evalString(prop.initializer, consts, opts);
  }
  return null;
}

export function literalValue(
  expr: ts.Expression,
  consts: Map<string, string>,
  opts?: { checker?: ts.TypeChecker; subst?: Map<string, string> },
): string | number | boolean | null | undefined {
  const node = unwrapExpr(expr);
  const str = evalString(node, consts, opts);
  if (str != null) return str;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;
  return undefined;
}
