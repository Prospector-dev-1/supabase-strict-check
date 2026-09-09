import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

export interface CliPaths {
  cwd: string;
  target: string;
  types: string;
}

function flagValue(argv: string[], name: string): string | undefined {
  const eq = `--${name}=`;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith(eq)) return arg.slice(eq.length);
    if (arg === `--${name}`) return argv[i + 1];
  }
  return undefined;
}

function resolveFromCwd(cwd: string, value: string): string {
  return path.resolve(cwd, value);
}

async function ask(cwd: string, kind: "directory" | "types"): Promise<string> {
  if (!input.isTTY || !output.isTTY) {
    throw new Error(
      kind === "directory"
        ? "missing --target= (path to directory from pwd)"
        : "missing --types= (path to supabase types file from pwd)",
    );
  }
  const rl = readline.createInterface({ input, output });
  try {
    const label = kind === "directory"
      ? `path to directory (allows '..' and '.', eg: '../../src') 
      \nFrom \`${cwd}\`
      \n> `
      : `path to supabase types (allows '..' and '.', eg: '../../src/types/supabase.types.ts')
      \nFrom \`${cwd}\`
      \n> `;
    const answer = (await rl.question(label)).trim();
    if (!answer) {
      throw new Error(kind === "directory" ? "directory path is required" : "types path is required");
    }
    return answer;
  } finally {
    rl.close();
  }
}

export async function resolveCliPaths(argv = process.argv.slice(2)): Promise<CliPaths> {
  const cwd = process.cwd();

  const targetArg = flagValue(argv, "target") ?? await ask(cwd, "directory");
  const target = resolveFromCwd(cwd, targetArg);
  if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
    throw new Error(`not a directory: ${targetArg} (resolved ${target})`);
  }
  console.log(`Targeted directory: ${target}`);

  const typesArg = flagValue(argv, "types") ?? await ask(cwd, "types");
  const types = resolveFromCwd(cwd, typesArg);
  if (!fs.existsSync(types) || !fs.statSync(types).isFile()) {
    throw new Error(`not a types file: ${typesArg} (resolved ${types})`);
  }
  console.log(`Types file: ${types}`);

  return { cwd, target, types };
}
