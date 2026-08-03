// ══════════════════════════════════════════════════════════════════════════
// Runs every 5 minutes via a Cron Trigger (configured in wrangler.toml, not
// in code). Each run re-reads settings/hotel fresh (checkOutTime, lead time,
// occupied-service time/toggle, timezone) — so a Super Admin changing any of
// those in Settings takes effect on the very next run with no redeploy.
//
// Idempotent by design: every task it creates uses a deterministic doc ID
// (`checkout_<bookingId>` / `occupied_<roomId>_<date>`) written via
// Firestore's atomic create-if-absent, so re-running this on overlapping
// schedules can never produce a duplicate task.
//
// ── Why this lives outside functions/ as its own Worker ─────────────────────
// Cloudflare Pages Functions (the `functions/` directory deployed alongside
// your site) do NOT support cron-triggered `scheduled()` handlers — that's
// a Workers-only capability, not exposed through Pages' file-based routing.
// Netlify's `schedule()` wrapper had no Pages equivalent, so this had to
// become a second, independently-deployed Worker rather than a file in
// `functions/`. It shares the same `functions/_shared/*` modules by relative
// import, so all business logic — trigger-time math, dedupe keys,
// notifications — is identical to the Netlify version; only the deployment
// mechanism differs.
//
// Deploying this: `cd workers/housekeeping-cron && npx wrangler deploy`
// (separately from your Pages deploy). Requires the same
// FIREBASE_SERVICE_ACCOUNT_KEY / FIREBASE_DATABASE_URL secrets, set via
// `npx wrangler secret put FIREBASE_SERVICE_ACCOUNT_KEY` — Worker secrets
// are configured independently from your Pages project's environment
// variables, even though the values are identical.
// ══════════════════════════════════════════════════════════════════════════
import type { Env } from "../../../functions/_shared/firebaseRest";
import { runHousekeepingQueueGeneration } from "../../../functions/_shared/housekeepingQueue";

export default {
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      (async () => {
        const result = await runHousekeepingQueueGeneration(env);
        console.log("[housekeeping-cron]", JSON.stringify(result));
      })()
    );
  },

  // A `fetch` handler isn't required for a cron-only Worker, but Wrangler
  // wants the module to export *something* routable, and having one makes
  // it trivial to trigger a run manually for testing (curl the Worker URL).
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("This Worker runs on a 5-minute Cron Trigger. POST here to trigger a run manually.", { status: 405 });
    }
    const result = await runHousekeepingQueueGeneration(env);
    return new Response(JSON.stringify(result), { headers: { "Content-Type": "application/json" } });
  },
};
