import type { QueryBinding } from "./types";

export class Scope {
  private readonly queries = new Map<string, QueryBinding>();
  private readonly objects = new Map<string, import("typescript").Expression>();

  constructor(private readonly parent?: Scope) {}

  child(): Scope {
    return new Scope(this);
  }

  setQuery(name: string, binding: QueryBinding): void {
    this.queries.set(name, {
      relation: binding.relation,
      embeds: new Map(binding.embeds),
    });
  }

  getQuery(name: string): QueryBinding | undefined {
    return this.queries.get(name) ?? this.parent?.getQuery(name);
  }

  setObject(name: string, expr: import("typescript").Expression): void {
    this.objects.set(name, expr);
  }

  getObject(name: string): import("typescript").Expression | undefined {
    return this.objects.get(name) ?? this.parent?.getObject(name);
  }
}
