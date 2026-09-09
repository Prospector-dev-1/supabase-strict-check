import ts from "typescript";

import { evalString, unwrapExpr } from "./ast";
import type { Catalog, Relation } from "./types";
import { relKey } from "./types";

const FACTORIES = new Set([
  "createCrudOps",
  "createReadOps",
  "createAppendOnlyOps",
  "createKeyedAppendOnlyOps",
]);

export const DB_PAYLOAD_METHODS = new Set([
  "insert",
  "append",
  "upsert",
  "update",
  "findOne",
  "findMany",
  "appendIfAbsent",
]);

export function camelToSnake(key: string): string {
  return key.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`);
}

function factoryTable(expr: ts.Expression, consts: Map<string, string>): string | null {
  const call = unwrapExpr(expr);
  if (!ts.isCallExpression(call)) return null;
  const callee = unwrapExpr(call.expression);
  const name = ts.isIdentifier(callee) ? callee.text : null;
  if (!name || !FACTORIES.has(name) || !call.arguments[0]) return null;
  return evalString(call.arguments[0], consts);
}

/** `export const db = { offerings: createCrudOps('offerings'), ... }` */
export function parseDbTableMap(sf: ts.SourceFile, catalog: Catalog): Map<string, Relation> {
  const map = new Map<string, Relation>();
  const consts = new Map<string, string>([["SCHEMA", "funding_portal"]]);

  const add = (alias: string, table: string | null): void => {
    if (!table) return;
    const relation = catalog.relations.get(relKey("funding_portal", table));
    if (relation) map.set(alias, relation);
  };

  const visitObj = (obj: ts.ObjectLiteralExpression, alias?: string): void => {
    for (const prop of obj.properties) {
      if (ts.isSpreadAssignment(prop)) {
        const table = factoryTable(prop.expression, consts);
        if (alias) add(alias, table);
        continue;
      }
      if (!ts.isPropertyAssignment(prop) && !ts.isShorthandPropertyAssignment(prop) && !ts.isMethodDeclaration(prop)) {
        continue;
      }
      const name = ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name) ? prop.name.text : null;
      if (!name) continue;
      if (ts.isPropertyAssignment(prop)) {
        const init = unwrapExpr(prop.initializer);
        const table = factoryTable(init, consts);
        if (table) add(name, table);
        else if (ts.isObjectLiteralExpression(init)) visitObj(init, name);
      }
    }
  };

  for (const stmt of sf.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    for (const decl of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || decl.name.text !== "db" || !decl.initializer) continue;
      const init = unwrapExpr(decl.initializer);
      if (ts.isObjectLiteralExpression(init)) visitObj(init);
    }
  }
  return map;
}

export function dbCall(
  call: ts.CallExpression,
): { alias: string; method: string } | null {
  if (!ts.isPropertyAccessExpression(call.expression)) return null;
  const method = call.expression.name.text;
  const recv = call.expression.expression;
  if (!ts.isPropertyAccessExpression(recv)) return null;
  if (!ts.isIdentifier(recv.expression) || recv.expression.text !== "db") return null;
  return { alias: recv.name.text, method };
}
