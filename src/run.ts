import fs from "node:fs";
import path from "node:path";

import ts from "typescript";

import { resolveCliPaths } from "./cli";
import { loadCatalog } from "./lib/catalog";
import { Checker, flushUnhitAnyPayloads, type PendingAnyPayload } from "./lib/checker";
import { createBackendProgram } from "./lib/program";
import type { QueryError } from "./lib/types";
import { collectSourceFiles, fileConsts, loadImportedConsts } from "./utils/files";

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

  const errors: QueryError[] = [];
  const warnings: QueryError[] = [];
  const instantiated = new Set<string>();
  const pendingAny: PendingAnyPayload[] = [];

  const makeChecker = (sf: ts.SourceFile) => new Checker({
    catalog,
    sf,
    consts: fileConsts(sf, imported),
    tsChecker,
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
