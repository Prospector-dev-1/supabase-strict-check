import fs from "node:fs";

import ts from "typescript";

import type { Catalog, Relation, Relationship, RpcFunction } from "./types";
import { relKey } from "./types";

function propName(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return null;
}

function typeName(member: ts.TypeElement): string | null {
  if (!ts.isPropertySignature(member) || !member.name) return null;
  return propName(member.name);
}

function asTypeLiteral(node: ts.TypeNode | undefined): ts.TypeLiteralNode | null {
  return node && ts.isTypeLiteralNode(node) ? node : null;
}

function stringFromType(node: ts.TypeNode | undefined): string | null {
  if (!node) return null;
  if (ts.isLiteralTypeNode(node) && ts.isStringLiteral(node.literal)) return node.literal.text;
  return null;
}

function boolFromType(node: ts.TypeNode | undefined): boolean {
  if (!node || !ts.isLiteralTypeNode(node)) return false;
  return node.literal.kind === ts.SyntaxKind.TrueKeyword;
}

function stringsFromTuple(node: ts.TypeNode | undefined): string[] {
  if (!node || !ts.isTupleTypeNode(node)) return [];
  const out: string[] = [];
  for (const el of node.elements) {
    const value = stringFromType(el);
    if (value != null) out.push(value);
  }
  return out;
}

function memberType(literal: ts.TypeLiteralNode, key: string): ts.TypeNode | undefined {
  for (const member of literal.members) {
    if (typeName(member) === key && ts.isPropertySignature(member)) {
      return member.type;
    }
  }
  return undefined;
}

function stringLiterals(node: ts.TypeNode | undefined): string[] {
  if (!node) return [];
  if (ts.isLiteralTypeNode(node) && ts.isStringLiteral(node.literal)) return [node.literal.text];
  if (ts.isUnionTypeNode(node)) {
    return node.types.flatMap((t) => stringLiterals(t));
  }
  if (ts.isParenthesizedTypeNode(node)) return stringLiterals(node.type);
  return [];
}

/** Database["public"]["Enums"]["status"] */
function enumIndex(node: ts.TypeNode | undefined): { schema: string; name: string } | null {
  if (!node || !ts.isIndexedAccessTypeNode(node)) return null;
  const name = stringFromType(node.indexType);
  const inner = node.objectType;
  if (!name || !ts.isIndexedAccessTypeNode(inner)) return null;
  const enumsKey = stringFromType(inner.indexType);
  if (enumsKey !== "Enums") return null;
  const schemaNode = inner.objectType;
  if (!ts.isIndexedAccessTypeNode(schemaNode)) return null;
  const schema = stringFromType(schemaNode.indexType);
  if (!schema) return null;
  return { schema, name };
}

function parseRelationships(node: ts.TypeNode | undefined): Relationship[] {
  if (!node || !ts.isTupleTypeNode(node)) return [];
  const rels: Relationship[] = [];
  for (const el of node.elements) {
    const literal = asTypeLiteral(el);
    if (!literal) continue;
    const foreignKeyName = stringFromType(memberType(literal, "foreignKeyName"));
    const referencedRelation = stringFromType(memberType(literal, "referencedRelation"));
    if (!foreignKeyName || !referencedRelation) continue;
    rels.push({
      foreignKeyName,
      columns: stringsFromTuple(memberType(literal, "columns")),
      isOneToOne: boolFromType(memberType(literal, "isOneToOne")),
      referencedRelation,
      referencedColumns: stringsFromTuple(memberType(literal, "referencedColumns")),
    });
  }
  return rels;
}

function parseColumns(
  row: ts.TypeNode | undefined,
  catalog: Catalog,
): { names: Set<string>; required: Set<string>; valueDomain: Map<string, string[]> } {
  const names = new Set<string>();
  const required = new Set<string>();
  const valueDomain = new Map<string, string[]>();
  const literal = asTypeLiteral(row);
  if (!literal) return { names, required, valueDomain };
  for (const member of literal.members) {
    const name = typeName(member);
    if (!name || !ts.isPropertySignature(member)) continue;
    names.add(name);
    if (!member.questionToken) required.add(name);
    const domain = stringLiterals(member.type);
    if (domain.length > 0) {
      valueDomain.set(name, domain);
      continue;
    }
    const ref = enumIndex(member.type);
    if (ref) {
      const values = catalog.enums.get(ref.schema)?.get(ref.name);
      if (values) valueDomain.set(name, values);
    }
  }
  return { names, required, valueDomain };
}

function parseRelationBlock(
  schema: string,
  name: string,
  kind: "table" | "view",
  node: ts.TypeNode,
  catalog: Catalog,
): Relation | null {
  const literal = asTypeLiteral(node);
  if (!literal) return null;
  const row = parseColumns(memberType(literal, "Row"), catalog);
  const insert = parseColumns(memberType(literal, "Insert"), catalog);
  const update = parseColumns(memberType(literal, "Update"), catalog);
  return {
    schema,
    name,
    kind,
    columns: row.names,
    insertColumns: insert.names,
    insertRequired: insert.required,
    updateColumns: update.names,
    relationships: parseRelationships(memberType(literal, "Relationships")),
    valueDomain: row.valueDomain.size ? row.valueDomain : insert.valueDomain,
  };
}

function parseNamedBlock(
  schema: string,
  kind: "table" | "view",
  node: ts.TypeNode | undefined,
  catalog: Catalog,
): void {
  const literal = asTypeLiteral(node);
  if (!literal) return;
  for (const member of literal.members) {
    const name = typeName(member);
    if (!name || !ts.isPropertySignature(member) || !member.type) continue;
    const relation = parseRelationBlock(schema, name, kind, member.type, catalog);
    if (!relation) continue;
    catalog.relations.set(relKey(schema, name), relation);
    const list = catalog.byName.get(name) ?? [];
    list.push(relation);
    catalog.byName.set(name, list);
  }
}

function parseRpc(name: string, node: ts.TypeNode): RpcFunction | null {
  const literal = asTypeLiteral(node);
  if (!literal) return null;
  const args = memberType(literal, "Args");
  if (!args) return { name, argNames: new Set(), requiredArgs: new Set(), argsNever: true };
  if (args.kind === ts.SyntaxKind.NeverKeyword) {
    return { name, argNames: new Set(), requiredArgs: new Set(), argsNever: true };
  }
  const body = asTypeLiteral(args);
  const argNames = new Set<string>();
  const requiredArgs = new Set<string>();
  if (body) {
    for (const member of body.members) {
      const arg = typeName(member);
      if (!arg || !ts.isPropertySignature(member)) continue;
      argNames.add(arg);
      if (!member.questionToken) requiredArgs.add(arg);
    }
  }
  return { name, argNames, requiredArgs, argsNever: false };
}

function parseFunctions(schema: string, node: ts.TypeNode | undefined, catalog: Catalog): void {
  const map = catalog.functions.get(schema) ?? new Map<string, RpcFunction>();
  const literal = asTypeLiteral(node);
  if (literal) {
    for (const member of literal.members) {
      const name = typeName(member);
      if (!name || !ts.isPropertySignature(member) || !member.type) continue;
      const fn = parseRpc(name, member.type);
      if (fn) map.set(name, fn);
    }
  }
  catalog.functions.set(schema, map);
}

function parseEnums(schema: string, node: ts.TypeNode | undefined, catalog: Catalog): void {
  const map = catalog.enums.get(schema) ?? new Map<string, string[]>();
  const literal = asTypeLiteral(node);
  if (literal) {
    for (const member of literal.members) {
      const name = typeName(member);
      if (!name || !ts.isPropertySignature(member)) continue;
      const values = stringLiterals(member.type);
      if (values.length) map.set(name, values);
    }
  }
  catalog.enums.set(schema, map);
}

export function loadCatalog(typesPath: string): Catalog {
  const text = fs.readFileSync(typesPath, "utf8");
  const sf = ts.createSourceFile(typesPath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const catalog: Catalog = {
    schemas: new Set(),
    relations: new Map(),
    byName: new Map(),
    functions: new Map(),
    enums: new Map(),
  };

  let database: ts.TypeLiteralNode | null = null;
  for (const stmt of sf.statements) {
    if (ts.isTypeAliasDeclaration(stmt) && stmt.name.text === "Database" && ts.isTypeLiteralNode(stmt.type)) {
      database = stmt.type;
      break;
    }
  }
  if (!database) {
    throw new Error(`Could not find 'export type Database = { ... }' in ${typesPath}`);
  }

  for (const member of database.members) {
    const schema = typeName(member);
    if (!schema || schema === "__InternalSupabase") continue;
    if (!ts.isPropertySignature(member) || !member.type) continue;
    const body = asTypeLiteral(member.type);
    if (!body) continue;
    catalog.schemas.add(schema);
    parseEnums(schema, memberType(body, "Enums"), catalog);
  }

  for (const member of database.members) {
    const schema = typeName(member);
    if (!schema || schema === "__InternalSupabase") continue;
    if (!ts.isPropertySignature(member) || !member.type) continue;
    const body = asTypeLiteral(member.type);
    if (!body) continue;
    parseNamedBlock(schema, "table", memberType(body, "Tables"), catalog);
    parseNamedBlock(schema, "view", memberType(body, "Views"), catalog);
    parseFunctions(schema, memberType(body, "Functions"), catalog);
  }

  if (catalog.relations.size === 0) {
    throw new Error(`Parsed 0 tables/views from ${typesPath}`);
  }
  return catalog;
}

export function resolveRelation(catalog: Catalog, schema: string, name: string): Relation | undefined {
  return catalog.relations.get(relKey(schema, name))
    ?? catalog.byName.get(name)?.find((r) => r.schema === schema)
    ?? (catalog.byName.get(name)?.length === 1 ? catalog.byName.get(name)![0] : undefined);
}

export function lookupTarget(catalog: Catalog, fromSchema: string, referencedRelation: string): Relation | undefined {
  return resolveRelation(catalog, fromSchema, referencedRelation);
}

export function pointsTo(catalog: Catalog, rel: Relationship, fromSchema: string, target: Relation): boolean {
  const referenced = lookupTarget(catalog, fromSchema, rel.referencedRelation);
  if (referenced) return referenced.schema === target.schema && referenced.name === target.name;
  return rel.referencedRelation === target.name;
}
