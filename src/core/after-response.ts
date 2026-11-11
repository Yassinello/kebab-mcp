/**
 * REL-05 (2026-11 audit): schedule best-effort work that must outlive the
 * HTTP response (durable log append, error webhook).
 *
 * On Vercel a lambda can be frozen as soon as the response is sent, which
 * silently drops un-awaited promises. Next's `after()` extends the
 * function's lifetime until the callback settles. Outside a request scope
 * (scripts, unit tests, background timers) `after()` throws — we then fall
 * back to plain fire-and-forget, which is what the code did before.
 */
import { after } from "next/server";
import { toMsg } from "./error-utils";

export function runAfterResponse(task: () => Promise<unknown>, label: string): void {
  const guarded = async () => {
    try {
      await task();
    } catch (err) {
      console.error(`[Kebab MCP] ${label} failed: ${toMsg(err)}`);
    }
  };
  try {
    after(guarded);
  } catch {
    // Not inside a request scope — run detached.
    // fire-and-forget OK: no request scope to extend (scripts/tests/timers); `guarded` logs its own failures
    void guarded();
  }
}
