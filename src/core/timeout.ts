/**
 * Small shared timeout helper. Wraps a promise so it rejects with a
 * descriptive Error if it doesn't settle within `ms`. Used by the
 * deep-health diagnose() path and the /api/setup/test dispatcher so
 * both share the same semantics and budget.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label = "operation"): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms);
    promise.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (err) => {
        clearTimeout(t);
        reject(err);
      }
    );
  });
}
