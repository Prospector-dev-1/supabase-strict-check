import ts from "typescript";

import {
  assignedName,
  chainProps,
  chainRoot,
  collectChain,
  evalString,
  evalStrings,
  isArrayFrom,
  isChainTail,
  enclosingParam,
  isParameterIdentifier,
  literalValue,
  loc,
  looksLikeClient,
  objectKeys,
  optionString,
  propName,
  stringish,
  unwrapExpr,
} from "../utils/ast";
import { relPath } from "../utils/files";
import { AGGREGATES, DEFAULT_SCHEMA, FILTER_COLUMN_METHODS, JOIN_HINTS, QUERY_METHODS, SKIP_CHAIN_PROPS } from "../utils/paths";
import { lookupTarget, pointsTo } from "./catalog";
import { calleeFunction, propertyNamesFromType } from "./program";
import { filterColumns, parseSelectList } from "./select";
import { Scope } from "./scope";
import type { Catalog, MethodCall, QueryError, Relation, Relationship, SelectItem } from "./types";
import { relKey } from "./types";

export interface PendingAnyPayload {
  fn: ts.FunctionLikeDeclaration;
  paramIndex: number;
  relation: Relation;
  kind: string;
  allowed: Set<string>;
  checkRequired: boolean;
  origin: ts.Node;
  hits: number;
  seenCalls: Set<string>;
}

export interface CheckerOptions {
  catalog: Catalog;
  sf: ts.SourceFile;
  consts: Map<string, string>;
  tsChecker?: ts.TypeChecker;
  subst?: Map<string, string>;
  instantiated?: Set<string>;
  pendingAny?: PendingAnyPayload[];
  errors?: QueryError[];
  warnings?: QueryError[];
}

export class Checker {
  readonly errors: QueryError[];
  readonly warnings: QueryError[];
  private readonly catalog: Catalog;
  private readonly sf: ts.SourceFile;
  private readonly consts: Map<string, string>;
  private readonly tsChecker?: ts.TypeChecker;
  private readonly subst: Map<string, string>;
  private readonly instantiated: Set<string>;
  private readonly pendingAny: PendingAnyPayload[];
  private resolvingPending = false;

  constructor(opts: CheckerOptions) {
    this.catalog = opts.catalog;
    this.sf = opts.sf;
    this.consts = opts.consts;
    this.tsChecker = opts.tsChecker;
    this.subst = opts.subst ?? new Map();
    this.instantiated = opts.instantiated ?? new Set();
    this.pendingAny = opts.pendingAny ?? [];
    this.errors = opts.errors ?? [];
    this.warnings = opts.warnings ?? [];
  }

  private evalOpts() {
    return { checker: this.tsChecker, subst: this.subst };
  }

  private str(expr: ts.Expression): string | null {
    return evalString(expr, this.consts, this.evalOpts());
  }

  fail(node: ts.Node, message: string): void {
    const { line, column } = loc(this.sf, node);
    this.errors.push({ file: relPath(this.sf.fileName), line, column, message });
  }

  warn(node: ts.Node, message: string): void {
    const { line, column } = loc(this.sf, node);
    this.warnings.push({ file: relPath(this.sf.fileName), line, column, message });
  }

  checkFile(): void {
    this.resolvingPending = false;
    this.visit(this.sf, new Scope());
  }

  followAnyPayloads(): void {
    this.resolvingPending = true;
    this.visit(this.sf, new Scope());
  }

  private spawn(sf: ts.SourceFile, subst: Map<string, string>): Checker {
    return new Checker({
      catalog: this.catalog,
      sf,
      consts: this.consts,
      tsChecker: this.tsChecker,
      subst,
      instantiated: this.instantiated,
      pendingAny: this.pendingAny,
      errors: this.errors,
      warnings: this.warnings,
    });
  }

  private visit(node: ts.Node, scope: Scope): void {
    const next = ts.isFunctionLike(node) || ts.isBlock(node) ? scope.child() : scope;

    if (ts.isCallExpression(node)) {
      if (this.resolvingPending) {
        this.applyPendingAtCall(node, next);
      } else {
        this.maybeInstantiate(node);
        if (isChainTail(node)) this.checkTail(node, next);
      }
    }

    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const init = unwrapExpr(node.initializer);
      if (ts.isObjectLiteralExpression(init) || ts.isArrayLiteralExpression(init)) {
        next.setObject(node.name.text, init);
      }
    }

    ts.forEachChild(node, (child) => this.visit(child, next));
  }

  private maybeInstantiate(call: ts.CallExpression): void {
    if (!this.tsChecker) return;
    if (ts.isPropertyAccessExpression(call.expression)) {
      const method = call.expression.name.text;
      if (QUERY_METHODS.has(method) || SKIP_CHAIN_PROPS.has(method)) return;
    }
    const fn = calleeFunction(call, this.tsChecker);
    if (!fn) return;
    const file = fn.getSourceFile().fileName;
    if (file.includes("node_modules") || file.endsWith(".d.ts")) return;
    const subst = this.substFromCall(fn, call);
    if (!subst) return;
    if (sameSubst(subst, this.subst)) return;
    const key = `${file}:${fn.getStart()}:${stringifySubst(subst)}`;
    if (this.instantiated.has(key)) return;
    this.instantiated.add(key);
    const body = fn.body;
    if (!body) return;
    this.spawn(fn.getSourceFile(), subst).visit(body, new Scope());
  }

  private applyPendingAtCall(call: ts.CallExpression, scope: Scope): void {
    if (!this.tsChecker || this.pendingAny.length === 0) return;
    const fn = calleeFunction(call, this.tsChecker);
    if (!fn) return;
    for (const pending of this.pendingAny) {
      if (!sameFunction(pending.fn, fn)) continue;
      const callId = `${call.getSourceFile().fileName}:${call.getStart()}`;
      if (pending.seenCalls.has(callId)) continue;
      pending.seenCalls.add(callId);
      const arg = call.arguments[pending.paramIndex];
      if (!arg) {
        pending.hits++;
        this.fail(call, `${pending.kind} on ${relKey(pending.relation.schema, pending.relation.name)}: missing payload argument`);
        continue;
      }
      const ident = unwrapExpr(arg);
      if (ts.isIdentifier(ident)) {
        const wrapper = enclosingParam(ident);
        if (wrapper && !sameFunction(wrapper.fn, pending.fn)) {
          this.queuePending({
            fn: wrapper.fn,
            paramIndex: wrapper.index,
            relation: pending.relation,
            kind: pending.kind,
            allowed: pending.allowed,
            checkRequired: pending.checkRequired,
            origin: pending.origin,
            hits: 0,
            seenCalls: new Set(),
          });
          pending.hits++;
          continue;
        }
      }
      pending.hits++;
      this.checkPayload(
        pending.relation,
        arg,
        pending.kind,
        pending.allowed,
        scope,
        pending.checkRequired,
        arg,
        "callsite",
      );
    }
  }

  private queuePending(item: PendingAnyPayload): void {
    const exists = this.pendingAny.some(
      (p) => sameFunction(p.fn, item.fn) && p.paramIndex === item.paramIndex && p.relation === item.relation && p.kind === item.kind,
    );
    if (!exists) this.pendingAny.push(item);
  }

  private substFromCall(fn: ts.FunctionLikeDeclaration, call: ts.CallExpression): Map<string, string> | null {
    const subst = new Map(this.subst);
    let bound = false;
    fn.parameters.forEach((param, i) => {
      const arg = call.arguments[i];
      if (!arg) return;
      if (ts.isIdentifier(param.name)) {
        const value = this.str(arg);
        if (value != null) {
          subst.set(param.name.text, value);
          bound = true;
        }
        return;
      }
      if (ts.isObjectBindingPattern(param.name)) {
        const obj = unwrapExpr(arg);
        if (!ts.isObjectLiteralExpression(obj)) return;
        for (const el of param.name.elements) {
          if (!ts.isBindingElement(el) || !ts.isIdentifier(el.name)) continue;
          const prop = el.propertyName && ts.isIdentifier(el.propertyName)
            ? el.propertyName.text
            : el.name.text;
          for (const p of obj.properties) {
            if (!ts.isPropertyAssignment(p)) continue;
            if (propName(p.name) !== prop) continue;
            const value = this.str(p.initializer);
            if (value != null) {
              subst.set(el.name.text, value);
              bound = true;
            }
          }
        }
      }
    });
    return bound ? subst : null;
  }

  private checkTail(tail: ts.CallExpression, scope: Scope): void {
    if (chainProps(tail.expression).some((n) => SKIP_CHAIN_PROPS.has(n))) return;

    const methods = collectChain(tail);
    if (methods.length === 0) return;

    const fromCall = methods.find((m) => m.name === "from");
    const rpcCall = methods.find((m) => m.name === "rpc");
    const schemaCall = methods.find((m) => m.name === "schema");
    if (fromCall?.name === "from" && isArrayFrom(fromCall)) return;

    const root = chainRoot(tail);
    const rootIdent = root && ts.isIdentifier(root) ? root.text : null;
    const continued = rootIdent ? scope.getQuery(rootIdent) : undefined;

    if (!fromCall && !rpcCall && !continued) return;
    if (fromCall && !continued && !rpcCall && !schemaCall && fromCall.name === "from") {
      const mutating = methods.some((m) =>
        ["select", "insert", "update", "upsert", "delete"].includes(m.name),
      );
      if (!mutating && !looksLikeClient(tail)) return;
    }

    let schema = continued?.relation.schema ?? DEFAULT_SCHEMA;
    let relation: Relation | undefined = continued?.relation;
    const embedAliases = new Map<string, Relation>(continued?.embeds ?? []);

    if (schemaCall) {
      if (!schemaCall.args[0]) {
        this.fail(schemaCall.node, "dynamic .schema(...)");
        return;
      }
      const schemaName = this.str(schemaCall.args[0]);
      if (!schemaName) {
        if (this.skipGenericParam(schemaCall.args[0])) return;
        this.fail(schemaCall.args[0], "dynamic .schema(...)");
        return;
      }
      if (!this.catalog.schemas.has(schemaName)) {
        this.fail(schemaCall.args[0], `unknown schema "${schemaName}"`);
        return;
      }
      schema = schemaName;
    }

    if (rpcCall) this.checkRpc(schema, rpcCall, scope);

    if (fromCall) {
      if (fromCall.args.length === 0) {
        this.fail(fromCall.node, "dynamic .from(...)");
        return;
      }
      const tableExpr = fromCall.args[0];
      const tableName = this.str(tableExpr);
      if (!tableName) {
        if (this.skipGenericParam(tableExpr)) return;
        this.fail(tableExpr, "dynamic .from(...)");
        return;
      }
      relation = this.catalog.relations.get(relKey(schema, tableName));
      if (!relation) {
        const elsewhere = this.catalog.byName.get(tableName);
        const hint = elsewhere?.length
          ? ` (exists in ${elsewhere.map((r) => r.schema).join(", ")})`
          : "";
        this.fail(
          tableExpr,
          `unknown relation "${tableName}" in schema "${schema}"${hint}`,
        );
        return;
      }
      embedAliases.clear();
    }

    if (!relation) return;

    for (const method of methods) {
      this.checkMethod(relation, method, embedAliases, scope);
    }

    const name = assignedName(tail);
    if (name) scope.setQuery(name, { relation, embeds: embedAliases });
  }

  private skipGenericParam(expr: ts.Expression): boolean {
    const ident = unwrapExpr(expr);
    if (!ts.isIdentifier(ident)) return false;
    if (this.subst.has(ident.text)) return false;
    return isParameterIdentifier(ident);
  }

  private resolvePayload(expr: ts.Expression | undefined, scope: Scope): ts.Expression | undefined {
    if (!expr) return undefined;
    const node = unwrapExpr(expr);
    if (ts.isIdentifier(node)) return scope.getObject(node.text) ?? expr;
    return expr;
  }

  private collectKeys(
    expr: ts.Expression | undefined,
    scope: Scope,
    depth = 0,
  ): { keys: string[]; unresolved: boolean } | null {
    if (!expr || depth > 6) return null;
    const node = unwrapExpr(expr);
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
      return this.collectKeys(node.right, scope, depth + 1);
    }
    if (ts.isConditionalExpression(node)) {
      const left = this.collectKeys(node.whenTrue, scope, depth + 1) ?? { keys: [], unresolved: false };
      const right = this.collectKeys(node.whenFalse, scope, depth + 1) ?? { keys: [], unresolved: false };
      return {
        keys: [...new Set([...left.keys, ...right.keys])],
        unresolved: left.unresolved || right.unresolved,
      };
    }
    if (ts.isIdentifier(node)) {
      const obj = scope.getObject(node.text);
      if (obj) return this.collectKeys(obj, scope, depth + 1);
      if (this.tsChecker) {
        const names = propertyNamesFromType(this.tsChecker, node);
        if (names) return { keys: names, unresolved: false };
      }
      return { keys: [], unresolved: true };
    }
    if (ts.isCallExpression(node)) {
      if (this.tsChecker) {
        const names = propertyNamesFromType(this.tsChecker, node);
        if (names) return { keys: names, unresolved: false };
      }
      return { keys: [], unresolved: true };
    }
    if (ts.isArrayLiteralExpression(node)) {
      const keys = new Set<string>();
      let unresolved = false;
      let any = false;
      for (const el of node.elements) {
        const inner = this.collectKeys(el, scope, depth + 1);
        if (!inner) continue;
        any = true;
        inner.keys.forEach((k) => keys.add(k));
        unresolved = unresolved || inner.unresolved;
      }
      return any ? { keys: [...keys], unresolved } : null;
    }
    if (!ts.isObjectLiteralExpression(node)) {
      if (this.tsChecker) {
        const names = propertyNamesFromType(this.tsChecker, node);
        if (names) return { keys: names, unresolved: false };
      }
      return { keys: [], unresolved: true };
    }
    const keys = new Set<string>();
    let unresolved = false;
    for (const prop of node.properties) {
      if (ts.isSpreadAssignment(prop)) {
        const inner = this.collectKeys(prop.expression, scope, depth + 1);
        if (!inner || inner.unresolved) unresolved = true;
        inner?.keys.forEach((k) => keys.add(k));
        continue;
      }
      if (ts.isPropertyAssignment(prop) || ts.isShorthandPropertyAssignment(prop)) {
        const name = propName(prop.name);
        if (name) keys.add(name);
      }
    }
    return { keys: [...keys], unresolved };
  }

  private checkRpc(schema: string, rpcCall: MethodCall, scope: Scope): void {
    if (rpcCall.args.length === 0) {
      this.fail(rpcCall.node, "dynamic .rpc(...)");
      return;
    }
    const fn = this.str(rpcCall.args[0]);
    if (!fn) {
      if (this.skipGenericParam(rpcCall.args[0])) return;
      this.fail(rpcCall.args[0], "dynamic .rpc(...)");
      return;
    }
    const rpc = this.catalog.functions.get(schema)?.get(fn);
    if (!rpc) {
      const found = [...this.catalog.functions.entries()]
        .filter(([, map]) => map.has(fn))
        .map(([s]) => s);
      const hint = found.length ? ` (exists in ${found.join(", ")})` : "";
      this.fail(rpcCall.args[0], `unknown rpc "${fn}" in schema "${schema}"${hint}`);
      return;
    }

    if (rpc.argsNever) {
      if (rpcCall.args[1]) this.fail(rpcCall.args[1], `rpc "${fn}" takes no args`);
      return;
    }

    if (!rpcCall.args[1]) {
      this.fail(rpcCall.node, `rpc "${fn}": missing args object`);
      return;
    }

    const collected = this.collectKeys(this.resolvePayload(rpcCall.args[1], scope), scope);
    if (!collected) {
      this.fail(rpcCall.args[1], `rpc "${fn}": dynamic args`);
      return;
    }
    if (collected.unresolved) {
      this.fail(rpcCall.args[1], `rpc "${fn}": unresolved spread/dynamic args`);
      return;
    }
    for (const key of collected.keys) {
      if (!rpc.argNames.has(key)) {
        this.fail(rpcCall.args[1], `rpc "${fn}": unknown arg "${key}"`);
      }
    }
    for (const req of rpc.argNames) {
      if (!collected.keys.includes(req)) {
        this.fail(rpcCall.args[1], `rpc "${fn}": missing arg "${req}"`);
      }
    }
  }

  private checkMethod(
    relation: Relation,
    method: MethodCall,
    embedAliases: Map<string, Relation>,
    scope: Scope,
  ): void {
    switch (method.name) {
      case "select":
        this.checkSelect(relation, method, embedAliases);
        break;
      case "insert":
        this.checkPayload(relation, method.args[0], "insert", relation.insertColumns, scope, true, method.node);
        break;
      case "update":
        this.checkPayload(relation, method.args[0], "update", relation.updateColumns, scope, false, method.node);
        break;
      case "upsert":
        this.checkPayload(relation, method.args[0], "upsert", relation.insertColumns, scope, false, method.node);
        this.checkOnConflict(relation, method);
        break;
      case "match":
        this.checkMatch(relation, method, embedAliases, scope);
        break;
      case "or":
        this.checkOr(relation, method, embedAliases);
        break;
      default:
        if (FILTER_COLUMN_METHODS.has(method.name) && method.args[0]) {
          this.checkFilterColumn(relation, method, embedAliases);
        }
    }
  }

  private checkPayload(
    relation: Relation,
    expr: ts.Expression | undefined,
    kind: string,
    allowed: Set<string>,
    scope: Scope,
    checkRequired: boolean,
    at: ts.Node,
    mode: "direct" | "callsite" = "direct",
  ): void {
    if (!expr) {
      this.fail(at, `${kind} on ${relKey(relation.schema, relation.name)}: missing payload`);
      return;
    }
    if (this.subst.size > 0) {
      const node = unwrapExpr(expr);
      if (ts.isIdentifier(node) && isParameterIdentifier(node)) return;
    }
    const collected = this.collectKeys(this.resolvePayload(expr, scope), scope);
    if (collected) {
      const keys = collected.keys;
      for (const key of keys) {
        if (!allowed.has(key)) {
          this.fail(expr, `${kind} on ${relKey(relation.schema, relation.name)}: unknown column "${key}"`);
        }
      }
      if (checkRequired && !collected.unresolved) {
        for (const req of relation.insertRequired) {
          if (!keys.includes(req)) {
            this.fail(expr, `insert on ${relKey(relation.schema, relation.name)}: missing required column "${req}"`);
          }
        }
      }
      const parsed = objectKeys(this.resolvePayload(expr, scope));
      if (parsed) {
        for (const key of parsed.keys) {
          this.checkLiteralDomain(relation, key, this.payloadValue(this.resolvePayload(expr, scope), key), expr, kind);
        }
      }
      if (!collected.unresolved) return;
    }

    const ident = unwrapExpr(expr);
    if (ts.isIdentifier(ident) && mode !== "callsite") {
      const param = enclosingParam(ident);
      if (param) {
        this.queuePending({
          fn: param.fn,
          paramIndex: param.index,
          relation,
          kind,
          allowed,
          checkRequired,
          origin: expr,
          hits: 0,
          seenCalls: new Set(),
        });
        return;
      }
    }

    this.fail(expr, `${kind} on ${relKey(relation.schema, relation.name)}: ${collected?.unresolved ? "unresolved spread in payload" : "dynamic payload"}`);
  }

  private payloadValue(expr: ts.Expression | undefined, key: string): ts.Expression | undefined {
    if (!expr) return undefined;
    const node = unwrapExpr(expr);
    const objs = ts.isArrayLiteralExpression(node)
      ? node.elements.map((el) => unwrapExpr(el)).filter(ts.isObjectLiteralExpression)
      : ts.isObjectLiteralExpression(node)
        ? [node]
        : [];
    for (const obj of objs) {
      for (const prop of obj.properties) {
        if (!ts.isPropertyAssignment(prop) && !ts.isShorthandPropertyAssignment(prop)) continue;
        const name = ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name) ? prop.name.text : null;
        if (name !== key) continue;
        if (ts.isPropertyAssignment(prop)) return prop.initializer;
      }
    }
    return undefined;
  }

  private checkLiteralDomain(
    relation: Relation,
    column: string,
    valueExpr: ts.Expression | undefined,
    node: ts.Node,
    via: string,
  ): void {
    if (!valueExpr) return;
    const domain = relation.valueDomain.get(column);
    if (!domain) return;
    const value = literalValue(valueExpr, this.consts, this.evalOpts());
    if (typeof value !== "string") return;
    if (!domain.includes(value)) {
      this.fail(
        node,
        `${via} on ${relKey(relation.schema, relation.name)}: "${column}" value "${value}" is not ${domain.join(" | ")}`,
      );
    }
  }

  private checkOnConflict(relation: Relation, method: MethodCall): void {
    const onConflict = optionString(method.args, ["onConflict"], this.consts, this.evalOpts());
    if (onConflict) {
      for (const col of onConflict.split(",").map((c) => c.trim()).filter(Boolean)) {
        if (!relation.columns.has(col)) {
          this.fail(
            method.args[1] ?? method.node,
            `upsert onConflict column "${col}" is not on ${relKey(relation.schema, relation.name)}`,
          );
        }
      }
      return;
    }
    const obj = method.args[1] ? unwrapExpr(method.args[1]) : undefined;
    if (!obj || !ts.isObjectLiteralExpression(obj)) return;
    for (const prop of obj.properties) {
      if (!ts.isPropertyAssignment(prop) && !ts.isShorthandPropertyAssignment(prop)) continue;
      if (propName(prop.name) !== "onConflict") continue;
      const value = ts.isPropertyAssignment(prop) ? prop.initializer : prop.name;
      if (this.skipGenericParam(value as ts.Expression)) return;
      this.fail(prop, `upsert on ${relKey(relation.schema, relation.name)}: dynamic onConflict`);
    }
  }

  private checkMatch(
    relation: Relation,
    method: MethodCall,
    embedAliases: Map<string, Relation>,
    scope: Scope,
  ): void {
    const collected = this.collectKeys(this.resolvePayload(method.args[0], scope), scope);
    if (!collected || collected.unresolved) {
      this.fail(method.args[0] ?? method.node, `match on ${relKey(relation.schema, relation.name)}: dynamic payload`);
      return;
    }
    for (const key of collected.keys) {
      this.assertColumnOrPath(relation, method.args[0], key, embedAliases, "match");
    }
  }

  private checkOr(
    relation: Relation,
    method: MethodCall,
    embedAliases: Map<string, Relation>,
  ): void {
    if (!method.args[0]) return;
    const extracted = stringish(method.args[0], this.consts, this.evalOpts());
    if (!extracted) return;
    const foreignTable = optionString(method.args, ["foreignTable", "referencedTable"], this.consts, this.evalOpts());
    let target = relation;
    if (foreignTable) {
      const resolved = this.resolveEmbed(relation, {
        alias: null,
        name: foreignTable,
        hints: [],
        children: [],
      }, method.node);
      if (!resolved) return;
      target = resolved;
      embedAliases.set(foreignTable, resolved);
    }
    for (const col of filterColumns(extracted.text)) {
      this.assertColumnOrPath(target, method.args[0], col, embedAliases, "or");
    }
  }

  private checkFilterColumn(
    relation: Relation,
    method: MethodCall,
    embedAliases: Map<string, Relation>,
  ): void {
    const cols = evalStrings(method.args[0], this.consts, this.evalOpts());
    if (!cols) {
      if (this.skipGenericParam(method.args[0])) return;
      this.fail(method.args[0], `${method.name} on ${relKey(relation.schema, relation.name)}: dynamic column`);
      return;
    }
    const foreignTable = optionString(method.args, ["foreignTable", "referencedTable"], this.consts, this.evalOpts());
    let target = relation;
    if (foreignTable) {
      const resolved = this.resolveEmbed(relation, {
        alias: null,
        name: foreignTable,
        hints: [],
        children: [],
      }, method.node);
      if (!resolved) return;
      target = resolved;
    }
    for (const extracted of cols) {
      this.assertColumnOrPath(target, method.args[0], extracted, embedAliases, method.name);
      if (method.args[1] && ["eq", "neq"].includes(method.name) && cols.length === 1) {
        this.checkLiteralDomain(target, extracted, method.args[1], method.args[1], method.name);
      }
    }
  }

  private checkSelect(
    relation: Relation,
    method: MethodCall,
    embedAliases: Map<string, Relation>,
  ): void {
    if (method.args.length === 0) return;
    const extracted = stringish(method.args[0], this.consts, this.evalOpts());
    if (!extracted?.complete) {
      if (this.skipGenericParam(method.args[0])) return;
      this.fail(method.args[0], `dynamic .select(...) on ${relKey(relation.schema, relation.name)}`);
      return;
    }
    this.walkSelect(relation, parseSelectList(extracted.text), method.args[0], embedAliases);
  }

  private walkSelect(
    relation: Relation,
    items: SelectItem[],
    node: ts.Node,
    embedAliases: Map<string, Relation>,
  ): void {
    for (const item of items) {
      if (item.name === "*") continue;
      if (item.children) {
        const target = this.resolveEmbed(relation, item, node);
        if (!target) continue;
        const alias = item.alias ?? item.name;
        embedAliases.set(alias, target);
        embedAliases.set(item.name, target);
        this.walkSelect(target, item.children, node, embedAliases);
        continue;
      }
      if (AGGREGATES.has(item.name)) continue;
      if (!relation.columns.has(item.name)) {
        this.fail(
          node,
          `select on ${relKey(relation.schema, relation.name)}: unknown column "${item.name}"`,
        );
      }
    }
  }

  private assertColumnOrPath(
    relation: Relation,
    node: ts.Node,
    column: string,
    embedAliases: Map<string, Relation>,
    via: string,
  ): void {
    if (relation.columns.has(column)) return;
    if (embedAliases.has(column) && (via === "is" || via === "not")) return;

    if (column.includes(".")) {
      const parts = column.split(".");
      let current: Relation | undefined = relation;
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        if (!current) break;
        if (i === parts.length - 1 && current.columns.has(part)) return;
        const aliased = embedAliases.get(part);
        if (aliased) {
          current = aliased;
          continue;
        }
        const next = this.resolveEmbed(current, {
          alias: null,
          name: part,
          hints: [],
          children: [],
        }, node, true);
        if (!next) {
          this.fail(
            node,
            `${via} on ${relKey(relation.schema, relation.name)}: cannot resolve path "${column}" at "${part}"`,
          );
          return;
        }
        current = next;
      }
      return;
    }

    this.fail(
      node,
      `${via} on ${relKey(relation.schema, relation.name)}: unknown column "${column}"`,
    );
  }

  private resolveEmbed(
    from: Relation,
    item: SelectItem,
    node: ts.Node,
    silent = false,
  ): Relation | undefined {
    const hints = item.hints.filter((h) => !JOIN_HINTS.has(h));
    const matches = this.embedCandidates(from, item.name, hints);

    if (matches.length === 1) return matches[0].target;
    if (matches.length > 1) {
      if (!silent) {
        const fks = matches.map((m) => m.via).join(", ");
        this.fail(
          node,
          `ambiguous embed "${item.name}" on ${relKey(from.schema, from.name)} — hint with !fk (${fks})`,
        );
      }
      return undefined;
    }

    if (!silent) {
      const hint = hints.length ? ` with hint !${hints.join("!")}` : "";
      this.fail(
        node,
        `no foreign key for embed "${item.name}"${hint} on ${relKey(from.schema, from.name)}`,
      );
    }
    return undefined;
  }

  private embedCandidates(
    from: Relation,
    name: string,
    hints: string[],
  ): { target: Relation; via: string }[] {
    const out: { target: Relation; via: string }[] = [];
    const seen = new Set<string>();

    const add = (target: Relation | undefined, via: string): void => {
      if (!target) return;
      const key = `${relKey(target.schema, target.name)}|${via}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ target, via });
    };

    const hintOk = (rel: Relationship): boolean => {
      if (hints.length === 0) return true;
      return hints.every(
        (h) => rel.foreignKeyName === h || rel.columns.includes(h) || rel.referencedColumns.includes(h),
      );
    };

    for (const rel of from.relationships) {
      const target = lookupTarget(this.catalog, from.schema, rel.referencedRelation);
      const nameMatches =
        rel.referencedRelation === name
        || rel.foreignKeyName === name
        || rel.columns.includes(name)
        || target?.name === name;
      if (!nameMatches || !hintOk(rel)) continue;
      add(target, rel.foreignKeyName);
    }

    for (const other of this.catalog.relations.values()) {
      for (const rel of other.relationships) {
        if (!pointsTo(this.catalog, rel, other.schema, from)) continue;
        const nameMatches =
          other.name === name
          || rel.foreignKeyName === name
          || rel.columns.includes(name);
        if (!nameMatches || !hintOk(rel)) continue;
        add(other, rel.foreignKeyName);
      }
    }

    return out;
  }
}

function sameFunction(a: ts.FunctionLikeDeclaration, b: ts.FunctionLikeDeclaration): boolean {
  return a === b
    || (a.getSourceFile().fileName === b.getSourceFile().fileName && a.getStart() === b.getStart());
}

export function flushUnhitAnyPayloads(pending: PendingAnyPayload[], errors: QueryError[]): void {
  for (const item of pending) {
    if (item.hits > 0) continue;
    const sf = item.origin.getSourceFile();
    const { line, column } = loc(sf, item.origin);
    errors.push({
      file: relPath(sf.fileName),
      line,
      column,
      message: `${item.kind} on ${relKey(item.relation.schema, item.relation.name)}: dynamic payload`,
    });
  }
}

function stringifySubst(subst: Map<string, string>): string {
  return [...subst.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join(",");
}

function sameSubst(a: Map<string, string>, b: Map<string, string>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) {
    if (b.get(k) !== v) return false;
  }
  return true;
}
