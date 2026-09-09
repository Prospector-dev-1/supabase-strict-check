export const DEFAULT_SCHEMA = "public";

export const JOIN_HINTS = new Set(["inner", "left"]);
export const AGGREGATES = new Set(["count", "sum", "avg", "min", "max"]);

export const FILTER_COLUMN_METHODS = new Set([
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
  "like",
  "ilike",
  "is",
  "in",
  "contains",
  "containedBy",
  "overlaps",
  "textSearch",
  "not",
  "filter",
  "order",
]);

export const SKIP_CHAIN_PROPS = new Set(["storage", "auth", "channel", "realtime"]);

export const QUERY_METHODS = new Set([
  "schema",
  "from",
  "select",
  "insert",
  "update",
  "upsert",
  "delete",
  "rpc",
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
  "like",
  "ilike",
  "is",
  "in",
  "contains",
  "containedBy",
  "overlaps",
  "textSearch",
  "not",
  "filter",
  "match",
  "or",
  "order",
  "limit",
  "range",
  "single",
  "maybeSingle",
  "throwOnError",
  "returns",
  "overrideTypes",
  "csv",
  "explain",
]);

export const CLIENT_NAMES = new Set([
  "supabase",
  "supabaseClient",
  "createClient",
]);
