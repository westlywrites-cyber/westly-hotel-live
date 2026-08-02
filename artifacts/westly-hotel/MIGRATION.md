# Netlify → Cloudflare Pages migration notes

## 1. `firebase-admin` does not run on Cloudflare Workers — here's why, and what replaced it

`firebase-admin`'s Firestore client talks gRPC over Node's `net`/`tls`/`http2`
modules, and its Auth helpers lean on `google-auth-library`, which assumes a
Node process (file-based credential caching, Node's `https.Agent`, etc.).
None of that exists in the Workers V8 isolate Cloudflare Pages Functions run
in — it's not a matter of a missing polyfill, the transport itself isn't
available.

Replacement: **`functions/_shared/firebaseRest.ts`**, a small REST client
built on `fetch()` and the Web Crypto API that talks directly to:
- **Firestore v1 REST API** (get/query/create-if-absent/set/update/add)
- **Identity Toolkit v1 REST API** (create user, update user/disable, verify ID tokens)
- **FCM v1 REST API** (send push)
- Firebase custom tokens, minted locally by RS256-signing a JWT with the
  service account's private key via `crypto.subtle` — no network call needed,
  same as what the Admin SDK does internally.

It authenticates using the **same `FIREBASE_SERVICE_ACCOUNT_KEY`** you
already have — no new credentials to generate.

One deliberate simplification: `admin.firestore.FieldValue.serverTimestamp()`
is a write-time sentinel the Admin SDK resolves via Firestore's transform
API. Every place this project used it was a single, immediately-committed
server write (never an offline/queued one), so I replaced it with a
timestamp captured at request time (`new Date()`) — behaviorally identical
here, just implemented without the sentinel machinery.

## 2. Functions converted (Netlify → Cloudflare)

| Netlify function | Cloudflare route | Client call site updated |
|---|---|---|
| `reset-password.ts` | `functions/api/reset-password.ts` → `POST /api/reset-password` | `src/lib/adminApi.ts` |
| `reset-pin.ts` | `functions/api/reset-pin.ts` → `POST /api/reset-pin` | `src/lib/adminApi.ts` |
| `set-user-status.ts` | `functions/api/set-user-status.ts` → `POST /api/set-user-status` | `src/lib/adminApi.ts` |
| `create-user.ts` | `functions/api/create-user.ts` → `POST /api/create-user` | `src/lib/adminApi.ts` |
| `send-push.ts` | `functions/api/send-push.ts` → `POST /api/send-push` | `src/lib/notifications.ts` |
| `verify-pin.ts` | `functions/api/verify-pin.ts` → `POST /api/verify-pin` | `src/lib/auth.ts` |
| `verify-guest-order.ts` | `functions/api/verify-guest-order.ts` → `POST /api/verify-guest-order` | `src/components/public/GuestMenuBrowser.tsx` |
| `housekeeping-queue-run-now.ts` | `functions/api/housekeeping-queue-run-now.ts` → `POST /api/housekeeping-queue-run-now` | `src/pages/admin/HousekeepingPage.tsx` |
| `housekeeping-queue-scheduled.ts` | **see flag below — moved to `workers/housekeeping-cron/`, not `functions/`** | n/a (no client call) |

All request validation, error messages, Firestore collection/field names,
and role checks are unchanged — only the Node/Admin-SDK plumbing changed.
`functions/_shared/` uses the same leading-underscore convention Netlify
used, and Cloudflare respects it the same way: files there aren't treated
as routes.

Cloudflare Pages Functions also auto-return `405 Method Not Allowed` for
any HTTP verb without a matching `onRequest<Verb>` export on a route, so
the `if (event.httpMethod !== "POST")` checks from the Netlify versions
were removed as redundant — the platform now does that for you.

## 3. Architectural flag: the 5-minute cron job needed a different home

**Cloudflare Pages Functions do not support cron-triggered `scheduled()`
handlers.** That's a Workers-only capability (configured via a Cron Trigger
in `wrangler.toml`), not something exposed through Pages' file-based
`functions/` routing — there's no Pages equivalent of Netlify's
`schedule()` wrapper.

So `housekeeping-queue-scheduled.ts` became its own, separately-deployed
Worker: **`workers/housekeeping-cron/`**. It imports the same
`functions/_shared/housekeepingQueue.ts` logic by relative path, so the
task-generation rules, dedupe keys, and notifications are identical — only
the deployment target differs. You'll deploy this once with:

```
cd workers/housekeeping-cron
npx wrangler secret put FIREBASE_SERVICE_ACCOUNT_KEY
npx wrangler deploy
```

Worker secrets are configured independently of your Pages project's
environment variables (separate `wrangler secret put`, even though the
value is identical to what's in the Pages dashboard).

## 4. Other things worth knowing before you deploy

- **`netlify.toml` is unused now.** Its subdomain redirects (`admin.*`,
  `hotel.*`), SPA catch-all, and security headers need to move to
  Cloudflare Pages' `_redirects` and `_headers` files. I didn't attempt an
  automatic conversion because Cloudflare's `_redirects` matches literal
  hostnames rather than Netlify's wildcard-apex `admin.*` syntax, and doing
  that correctly needs your actual production domain — happy to write those
  once you tell me the domain you're pointing at Cloudflare.
- **`identitytoolkit` admin REST calls** (`create-user`, `set-user-status`,
  `reset-password`) are the part of this migration I'd test first and most
  carefully — they're functionally equivalent to what the Admin SDK does
  internally, but they're new code exercising a less commonly-documented
  corner of Google's REST surface. Try creating a test user and suspending/
  reactivating it in a Cloudflare Pages preview deploy before relying on it
  in production.
- `firebase-admin` and `@netlify/functions` were removed from
  `package.json`; nothing else in `src/` imports `firebase-admin` (it's a
  separate package from the client `firebase` SDK you still use for
  Firestore/Auth/RTDB in the browser, which is untouched).

## 5. Environment variables to re-add in Cloudflare Pages → Settings → Environment variables and secrets

**Server-side (used by `functions/` and the cron Worker) — add as Secrets:**

| Variable | Notes |
|---|---|
| `FIREBASE_SERVICE_ACCOUNT_KEY` | Required. Same base64-encoded service account JSON as on Netlify. |
| `FIREBASE_DATABASE_URL` | Optional — kept for parity with the old name, but no current server function reads it (none of them touch Realtime Database; that's client-only via `src/lib/firebase.ts`). |

**Build-time client vars (used by Vite, prefixed `VITE_`) — add as regular Environment variables, applied at build time:**

| Variable | Notes |
|---|---|
| `VITE_SUPABASE_URL` | Required — no fallback in code. |
| `VITE_SUPABASE_ANON_KEY` | Required — no fallback in code. |
| `VITE_FIREBASE_VAPID_KEY` | Required for web push — no fallback in code. |

The remaining `VITE_FIREBASE_*` vars (`API_KEY`, `AUTH_DOMAIN`,
`PROJECT_ID`, `STORAGE_BUCKET`, `MESSAGING_SENDER_ID`, `APP_ID`,
`MEASUREMENT_ID`, `DATABASE_URL`) all have hardcoded fallback values baked
into `src/lib/firebase.ts`, so they'll keep working even if you don't set
them — but re-adding them explicitly in Cloudflare is still good practice
if you ever rotate these values.

Remember: Pages environment variables are typically scoped per
environment (Production vs. Preview) — set them in both if you want
preview deploys to work too.
