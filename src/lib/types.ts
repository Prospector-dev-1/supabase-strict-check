export interface Relationship {
  foreignKeyName: string;
  columns: string[];
  isOneToOne: boolean;
  referencedRelation: string;
  referencedColumns: string[];
}

export interface RpcFunction {
  name: string;
  argNames: Set<string>;
  requiredArgs: Set<string>;
  argsNever: boolean;
}

export interface Relation {
  schema: string;
  name: string;
  kind: "table" | "view";
  columns: Set<string>;
  insertColumns: Set<string>;
  insertRequired: Set<string>;
  updateColumns: Set<string>;
  relationships: Relationship[];
  /** string-literal domains for a column (enums / unions), if known */
  valueDomain: Map<string, string[]>;
}

export interface Catalog {
  schemas: Set<string>;
  relations: Map<string, Relation>;
  byName: Map<string, Relation[]>;
  functions: Map<string, Map<string, RpcFunction>>;
  enums: Map<string, Map<string, string[]>>;
}

export interface SelectItem {
  alias: string | null;
  name: string;
  hints: string[];
  children: SelectItem[] | null;
}

export interface QueryError {
  file: string;
  line: number;
  column: number;
  message: string;
}

export interface MethodCall {
  name: string;
  args: import("typescript").Expression[];
  node: import("typescript").CallExpression;
}

export interface QueryBinding {
  relation: Relation;
  embeds: Map<string, Relation>;
}

export function relKey(schema: string, name: string): string {
  return `${schema}.${name}`;
}
