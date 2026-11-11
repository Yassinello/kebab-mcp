/**
 * REL-01 (2026-11 audit): process-wide caches of tenant-owned data must be
 * keyed by tenant. A single global slot served tenant A's skills / API
 * tools / custom tools to tenant B on a warm lambda.
 */
import { getCurrentTenantId } from "./request-context";

const ROOT = "__root__";

export class TenantCache<T> {
  private readonly slots = new Map<string, T>();

  private key(): string {
    return getCurrentTenantId() ?? ROOT;
  }

  get(): T | undefined {
    return this.slots.get(this.key());
  }

  set(value: T): void {
    this.slots.set(this.key(), value);
  }

  delete(): void {
    this.slots.delete(this.key());
  }

  clear(): void {
    this.slots.clear();
  }
}
