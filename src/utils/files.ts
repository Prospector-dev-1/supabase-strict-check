import fs from "node:fs";
import path from "node:path";

import ts from "typescript";

import { unwrapExpr } from "./ast";

export function collectSourceFiles(root: string, typesFile: string): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "dist") continue;
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
        files.push(full);
      }
    }
  };
  walk(root);
  return files.filter((f) => path.resolve(f) !== path.resolve(typesFile));
}

function moduleStringConsts(sf: ts.SourceFile): Map<string, string> {
  const map = new Map<string, string>();
  for (const stmt of sf.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    for (const decl of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;
      const node = unwrapExpr(decl.initializer);
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        map.set(decl.name.text, node.text);
      }
    }
  }
  return map;
}

function resolveImport(fromFile: string, spec: string, srcDir: string): string | null {
  if (spec.startsWith("@/")) {
    spec = path.join(srcDir, spec.slice(2));
  } else if (spec.startsWith(".")) {
    spec = path.resolve(path.dirname(fromFile), spec);
  } else {
    return null;
  }
  const candidates = [
    spec,
    spec + ".ts",
    path.join(spec, "index.ts"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  }
  return null;
}

/** Module-level `const X = "..."`, including re-exports via named imports. */
export function loadImportedConsts(files: string[], srcDir: string): Map<string, Map<string, string>> {
  const parsed = new Map<string, ts.SourceFile>();
  const local = new Map<string, Map<string, string>>();

  for (const file of files) {
    const sf = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    parsed.set(file, sf);
    local.set(file, moduleStringConsts(sf));
  }

  const resolved = new Map<string, Map<string, string>>();
  const visiting = new Set<string>();

  const resolveFile = (file: string): Map<string, string> => {
    const hit = resolved.get(file);
    if (hit) return hit;
    if (visiting.has(file)) return local.get(file) ?? new Map();
    visiting.add(file);

    const out = new Map(local.get(file) ?? []);
    const sf = parsed.get(file);
    if (sf) {
      for (const stmt of sf.statements) {
        if (!ts.isImportDeclaration(stmt) || !stmt.importClause) continue;
        if (!ts.isStringLiteral(stmt.moduleSpecifier)) continue;
        const target = resolveImport(file, stmt.moduleSpecifier.text, srcDir);
        if (!target) continue;
        const exported = resolveFile(target);
        const named = stmt.importClause.namedBindings;
        if (named && ts.isNamedImports(named)) {
          for (const el of named.elements) {
            const imported = (el.propertyName ?? el.name).text;
            const localName = el.name.text;
            const value = exported.get(imported);
            if (value != null) out.set(localName, value);
          }
        }
      }
    }

    resolved.set(file, out);
    visiting.delete(file);
    return out;
  };

  for (const file of files) resolveFile(file);
  return resolved;
}

export function fileConsts(
  sf: ts.SourceFile,
  imported: Map<string, Map<string, string>>,
): Map<string, string> {
  const map = new Map(imported.get(path.resolve(sf.fileName)) ?? []);
  const counts = new Map<string, number>();

  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const init = unwrapExpr(node.initializer);
      if (ts.isStringLiteral(init) || ts.isNoSubstitutionTemplateLiteral(init)) {
        const name = node.name.text;
        counts.set(name, (counts.get(name) ?? 0) + 1);
        map.set(name, init.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  for (const [name, count] of counts) {
    if (count > 1) map.delete(name);
  }
  return map;
}

export function relPath(file: string, from = process.cwd()): string {
  return path.relative(from, file);
}
