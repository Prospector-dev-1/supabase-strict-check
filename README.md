# supabase-strict-check

Checker for PostgREST/Supabase client queries against generated `Database` types.

It walks TypeScript source, resolves `.from()`, `.select()`, filters, inserts/updates, and RPC calls, and reports columns, relations, and payloads that do not match the generated types file.

## Quick start

```bash
npm install -g supabase-strict-check
supabase-strict-check --target=src --types=src/types/supabase.ts
```

## Flags

| Flag | Meaning |
| --- | --- |
| `--target` | Directory of TypeScript source to scan |
| `--types` | Path to the generated Supabase types file (`export type Database = { ... }`) |

Omit both flags to be prompted (TTY only).

## License

MIT. See [LICENSE](LICENSE).

## Contributing

See [CONTRIBUTING](CONTRIBUTING.md)
