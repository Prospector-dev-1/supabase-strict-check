# supabase-strict-check

Static checker for PostgREST/Supabase client queries against generated `Database` types.

It walks TypeScript source, resolves `.from()`, `.select()`, filters, inserts/updates, and RPC calls, and reports columns, relations, and payloads that do not match the generated types file.

## Quick start

```sh
npm install
npm start -- --target=path/to/src --types=path/to/types/supabase.ts
```

Or from another project:

```json
{
  "scripts": {
    "check:supabase": "tsx node_modules/supabase-strict-check/src/index.ts --target=src --types=src/types/supabase.ts"
  }
}
```

## Flags

| Flag | Meaning |
| --- | --- |
| `--target` | Directory of TypeScript source to scan |
| `--types` | Path to the generated Supabase types file (`export type Database = { ... }`) |

Omit both flags to be prompted (TTY only).

## Layout

```
src/          entry, CLI, and run pipeline
src/lib/      catalog, checker, TypeScript program, select/scope
src/utils/    AST helpers, file walking, constants
dist/         compiled output (`npm run build`)
```
