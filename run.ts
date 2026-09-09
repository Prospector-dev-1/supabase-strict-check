import fs from "node:fs";
import path from "node:path";

import ts from "typescript";

import { loadCatalog } from "./catalog";
import { Checker, flushUnhitAnyPayloads, type PendingAnyPayload } from "./checker";
import { resolveCliPaths } from "./cli";
import { collectSourceFiles, fileConsts, loadImportedConsts } from "./files";
import { parseDbTableMap } from "./helpers";
import { createBackendProgram } from "./program";
import type { QueryError } from "./types";

function formatIssue(issue: QueryError, kind: "error" | "warning"): string {
  return `${kind} ${issue.file}:${issue.line}:${issue.column}  ${issue.message}`;
}

export async function run(): Promise<void> {
  const { cwd, target, types } = await resolveCliPaths();

  const catalog = loadCatalog(types);
  const files = collectSourceFiles(target, types);
  const srcDir = fs.existsSync(path.join(target, "src")) ? path.join(target, "src") : target;
  const program = createBackendProgram(target, files, types);
  const tsChecker = program.getTypeChecker();
  const imported = loadImportedConsts(files, srcDir);
  const dbTables = new Map();
  for (const file of files) {
    if (!file.replace(/\\/g, "/").endsWith("/lib/fundingPortal/modules/common/db.ts")) continue;
    const sf = program.getSourceFile(file);
    if (sf) parseDbTableMap(sf, catalog).forEach((v, k) => dbTables.set(k, v));
  }

  const errors: QueryError[] = [];
  const warnings: QueryError[] = [];
  const instantiated = new Set<string>();
  const pendingAny: PendingAnyPayload[] = [];

  const makeChecker = (sf: ts.SourceFile) => new Checker({
    catalog,
    sf,
    consts: fileConsts(sf, imported),
    tsChecker,
    dbTables,
    instantiated,
    pendingAny,
    errors,
    warnings,
  });

  for (const file of files) {
    const sf = program.getSourceFile(file);
    if (!sf) continue;
    makeChecker(sf).checkFile();
  }

  for (let i = 0; i < 20; i++) {
    const before = pendingAny.length;
    for (const file of files) {
      const sf = program.getSourceFile(file);
      if (!sf) continue;
      makeChecker(sf).followAnyPayloads();
    }
    if (pendingAny.length === before) break;
  }
  flushUnhitAnyPayloads(pendingAny, errors);

  for (const warning of warnings) console.warn(formatIssue(warning, "warning"));
  for (const error of errors) console.error(formatIssue(error, "error"));

  const summary = `checked ${files.length} files in ${path.relative(cwd, target) || "."} against ${catalog.relations.size} relations`;
  if (errors.length === 0) {
    console.log(`${summary} — ok`);
    return;
  }

  console.error(`\n${summary} — ${errors.length} error(s)`);
  process.exitCode = 1;
}
