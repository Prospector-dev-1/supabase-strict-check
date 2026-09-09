import type { SelectItem } from "./types";

export function splitTopLevel(input: string, sep: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inQuote: string | null = null;
  let start = 0;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (inQuote) {
      if (ch === inQuote && input[i - 1] !== "\\") inQuote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      inQuote = ch;
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === sep && depth === 0) {
      parts.push(input.slice(start, i));
      start = i + sep.length;
    }
  }
  parts.push(input.slice(start));
  return parts;
}

export function parseSelectList(input: string): SelectItem[] {
  const trimmed = input.trim();
  if (!trimmed) return [];
  const items: SelectItem[] = [];
  for (const part of splitTopLevel(trimmed, ",")) {
    const item = parseSelectItem(part.trim());
    if (item) items.push(item);
  }
  return items;
}

export function parseSelectItem(raw: string): SelectItem | null {
  let s = raw.trim();
  if (!s) return null;

  let children: SelectItem[] | null = null;
  if (s.endsWith(")")) {
    let depth = 0;
    let open = -1;
    for (let i = s.length - 1; i >= 0; i--) {
      if (s[i] === ")") depth++;
      else if (s[i] === "(") {
        depth--;
        if (depth === 0) {
          open = i;
          break;
        }
      }
    }
    if (open >= 0) {
      children = parseSelectList(s.slice(open + 1, s.length - 1));
      s = s.slice(0, open).trim();
    }
  }

  let alias: string | null = null;
  const colon = s.indexOf(":");
  if (colon > 0) {
    const maybeAlias = s.slice(0, colon).trim();
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(maybeAlias) && !maybeAlias.includes("!")) {
      alias = maybeAlias;
      s = s.slice(colon + 1).trim();
    }
  }

  const bangParts = s.split("!").map((p) => p.trim()).filter(Boolean);
  if (bangParts.length === 0) return null;
  let name = bangParts[0];
  const castAt = name.indexOf("::");
  if (castAt >= 0) name = name.slice(0, castAt).trim();
  if (name === "") return null;

  return {
    alias,
    name,
    hints: bangParts.slice(1).map((h) => h.replace(/::.*$/, "")),
    children,
  };
}

const FILTER_OP = /^(eq|neq|gt|gte|lt|lte|like|ilike|is|in|cs|cd|ov|fts|not|match)$/i;

/** Columns referenced in PostgREST `or` / `and` filter strings. */
export function filterColumns(filter: string): string[] {
  const cols: string[] = [];

  const walk = (s: string): void => {
    const trimmed = s.trim();
    if (!trimmed) return;
    const grouped = trimmed.match(/^(and|or)\((.*)\)$/i);
    if (grouped) {
      for (const part of splitTopLevel(grouped[2], ",")) walk(part);
      return;
    }
    const notWrap = trimmed.match(/^not\((.*)\)$/i);
    if (notWrap) {
      walk(notWrap[1]);
      return;
    }
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_.]*)\.(eq|neq|gt|gte|lt|lte|like|ilike|is|in|cs|cd|ov|fts|not|match)\b/i);
    if (match && FILTER_OP.test(match[2])) {
      cols.push(match[1]);
      return;
    }
    const re = /([A-Za-z_][A-Za-z0-9_.]*)\.(eq|neq|gt|gte|lt|lte|like|ilike|is|in|cs|cd|ov|fts|not|match)\b/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(trimmed))) cols.push(m[1]);
  };

  walk(filter);
  return cols;
}
