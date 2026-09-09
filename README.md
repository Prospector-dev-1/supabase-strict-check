# Supabase Strict Check

[![npm](https://img.shields.io/npm/v/supabase-strict-check)](https://www.npmjs.com/package/supabase-strict-check)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-Ready-blue.svg)](https://www.typescriptlang.org/)
Checker for PostgREST/Supabase client queries against generated `Database` types.

**This is not an official Supabase package.** It is an independent community tool and is not affiliated with, endorsed by, or maintained by Supabase.

It walks TypeScript source, resolves `.from()`, `.select()`, filters, inserts/updates, and RPC calls, and reports columns, relations, and payloads that do not match the generated types file.

## Quick start

### Install

```bash
npm install --save-dev supabase-strict-check
```

### Run

```bash
# Note: DO NOT START THE PATH WITH A `/`
npx supabase-strict-check --target=src --types=src/types/database.types.ts
```

OR

```bash
# This will prompt you for the target and types paths
npx supabase-strict-check
```

### Tip

Add a script to your `package.json`:

```json
"scripts": {
  "check:supabase-strict": "supabase-strict-check --target=src --types=src/types/database.types.ts"
}
```

Then run `npm run check:supabase`.

## Flags

| Flag | Meaning |
| --- | --- |
| `--target` | Directory of TypeScript source to scan (`.ts`, `.tsx`) |
| `--types` | Path to the generated Supabase types file (`export type Database = { ... }`) |

Omit both flags to be prompted (TTY only).

## License

MIT. See [LICENSE](LICENSE).

## Contributing

See [CONTRIBUTING](CONTRIBUTING.md)
