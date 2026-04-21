/**
 * server.js — SIGTERM-aware entry wrapper for Next standalone output.
 *
 * Phase 39 / HOST-02: Persistent-process deployments (Docker, Fly, Render,
 * Cloud Run, bare-metal) need a graceful shutdown story. Next's standalone
 * server.js does not install SIGTERM handlers itself — it relies on the
 * process manager to SIGKILL on timeout. That drops in-flight requests.
 *
 * This wrapper is COPY'd into /app/server.js in the Dockerfile runner
 * stage AFTER the standalone extract, overwriting .next/standalone/server.js
 * at the container level. It require()s the standalone entry so Next's
 * http.createServer runs in this same process, then installs SIGTERM +
 * SIGINT handlers that grant a drain window before exit.
 *
 * Config (JC-2):
 *   - Default drain: 5000 ms.
 *   - Override: MYMCP_SHUTDOWN_TIMEOUT_MS=<ms> (minimum 1000).
 *   - Ignored on Vercel (lambdas are SIGKILL'd by the runtime).
 *
 * Behavior:
 *   - On SIGTERM/SIGINT, log the drain intent.
 *   - Let active HTTP connections flush on their own — we do NOT call
 *     server.close() because the standalone server is not exported.
 *     Node's active-handle bookkeeping keeps the process alive while
 *     sockets are open; the unref()'d timer is the hard deadline.
 *   - If all handles close before the deadline, the process exits early
 *     (unref means the timer does not keep the loop alive on its own).
 */

const TIMEOUT_MS = Math.max(
  1000,
  parseInt(process.env.MYMCP_SHUTDOWN_TIMEOUT_MS ?? "5000", 10) || 5000
);

// Delegate to Next standalone server. require() runs it in this process,
// so our SIGTERM handler shares the event loop with the HTTP server.
require("./.next/standalone/server.js");

let shuttingDown = false;

function drain(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  // eslint-disable-next-line no-console
  console.log(`[shutdown] Received ${signal}, draining in ${TIMEOUT_MS}ms...`);
  const timer = setTimeout(() => {
    // eslint-disable-next-line no-console
    console.log("[shutdown] Drain window elapsed, exiting.");
    process.exit(0);
  }, TIMEOUT_MS);
  // unref() so the process exits as soon as all active handles (sockets,
  // timers, etc.) close on their own — this is the "early exit on clean
  // drain" path. The timer is the hard deadline for unclean shutdowns.
  timer.unref();
}

process.on("SIGTERM", () => drain("SIGTERM"));
process.on("SIGINT", () => drain("SIGINT"));
