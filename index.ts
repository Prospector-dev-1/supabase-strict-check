/**
 * Static PostgREST/Supabase checker.
 *
 *   npm run check:supabase -- --target=src --types=src/types/supabase.ts
 *
 * Paths are from pwd. Omit flags to be prompted.
 */
import { run } from "./run";


export function main() {
  run().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
}

main();