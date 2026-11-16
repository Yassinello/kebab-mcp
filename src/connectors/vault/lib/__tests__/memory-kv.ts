/**
 * In-memory KVStore for vault backend tests (with or without scan/mget).
 * `shared: true` behaves like Upstash: kind "upstash" and an atomic
 * setIfNotExists (TTL ignored), as several instances would see it.
 */
import type { KVStore } from "@/core/kv-store";

export function makeMemoryKV(
  opts: { scan?: boolean; mget?: boolean; shared?: boolean } = {}
): KVStore & {
  store: Map<string, string>;
} {
  const store = new Map<string, string>();
  const kv: KVStore & { store: Map<string, string> } = {
    store,
    kind: opts.shared ? "upstash" : "filesystem",
    get: async (k) => store.get(k) ?? null,
    set: async (k, v) => {
      store.set(k, v);
    },
    delete: async (k) => {
      store.delete(k);
    },
    list: async (prefix) =>
      Array.from(store.keys()).filter((k) => (prefix ? k.startsWith(prefix) : true)),
  };
  if (opts.scan !== false) {
    kv.scan = async (cursor, o) => {
      const match = o?.match ?? "*";
      const all = Array.from(store.keys()).filter((k) =>
        match.endsWith("*") ? k.startsWith(match.slice(0, -1)) : k === match
      );
      const offset = cursor === "0" ? 0 : parseInt(cursor, 10);
      const count = o?.count ?? 100;
      const next = offset + count;
      return { cursor: next >= all.length ? "0" : String(next), keys: all.slice(offset, next) };
    };
  }
  if (opts.shared) {
    kv.setIfNotExists = async (k, v) => {
      const existing = store.get(k);
      if (existing !== undefined) return { ok: false, existing };
      store.set(k, v);
      return { ok: true };
    };
  }
  if (opts.mget !== false) {
    kv.mget = async (keys) => keys.map((k) => store.get(k) ?? null);
  }
  return kv;
}
