# Deployment — Westly Demo Hotel

**Status:** Phase 1 (Unblock Deployment) of the Production Readiness plan. This document is the decision record and reference for how this project deploys. It supersedes `netlify.toml`, which has been deleted.

## 1. Decision record

- **Cloudflare Pages** is the committed deploy target for the static site and `functions/api/*` (Cloudflare Pages Functions).
- The 5-minute housekeeping queue job runs as a **separate, independently deployed Cloudflare Worker** at `workers/housekeeping-cron/`. Cloudflare Pages Functions cannot run cron-triggered `scheduled()` handlers — that is a Workers-only capability — so this piece cannot live inside `functions/`.
- **Netlify is deprecated.** `netlify.toml` has been deleted from the repository. Its header rules, SPA catch-all, and subdomain-redirect rules have been ported to Cloudflare's `_headers` / `_redirects` convention (see §3–4 below) before the file was removed.

### Cloudflare Pages dashboard settings

| Setting | Value |
|---|---|
| Build command | `pnpm install && pnpm run build` |
| Output directory | `dist/public` |
| Functions directory | Auto-detected from the repo-root `functions/` folder |

## 2. Worker connect-src verification (important correction)

The original `netlify.toml` CSP hard-coded `https://westlyhotel.investorwestly.workers.dev` into `connect-src`. Direct inspection of the codebase shows this is **not** the housekeeping-cron Worker (`westly-hotel-housekeeping-cron`, per `workers/housekeeping-cron/wrangler.toml`) — it's a separate Telegram/push-notification relay Worker, referenced as `CLOUDFLARE_WORKER_URL` in `src/lib/notifications.ts` and independently as `TELEGRAM_WORKER_URL` in `functions/_shared/serverNotify.ts`.

`src/lib/notifications.ts` calls this Worker **directly from the browser** (`notify()` is invoked from ~20 client pages/components, and it does a client-side `fetch(CLOUDFLARE_WORKER_URL, …)`). So this hostname must stay in `connect-src` or those calls will be blocked by CSP — it has been kept.

Separately, `src/pages/admin/HousekeepingPage.tsx`'s "run queue now" button only calls the same-origin Pages Function `POST /api/housekeeping-queue-run-now` (covered by `'self'`). The housekeeping-cron Worker itself is **never called directly from the browser** — it only runs on its own cron trigger — so no additional `connect-src` entry was needed for it.

Net effect: the `connect-src` list carried over from `netlify.toml` was already correct as written; no origins were added or removed, only the syntax was ported to `_headers`.

## 3. `public/_headers`

Ports every `netlify.toml` `[[headers]]` block:

- `/*` — `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `X-XSS-Protection: 1; mode=block`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy: camera=(), microphone=(), geolocation=()`, and the full CSP (see §2 above for the `connect-src` verification).
- `/assets/*` — `Cache-Control: public, max-age=31536000, immutable`. Verified safe: `vite.config.ts` has no `rollupOptions.output.entryFileNames` override, so Vite's default content-hashed filenames are in effect — a stale unhashed file being cached for a year is not a risk here.
- `/admin-sw.js` and `/admin-manifest.webmanifest` — `Cache-Control: no-cache`, so PWA updates reach installed devices promptly.
- HTML documents intentionally have no explicit caching rule — Cloudflare Pages' default (revalidate every request) applies.

## 4. `public/_redirects`

Two sections:

1. **SPA catch-all** — `/* /index.html 200`. Works immediately, no domain knowledge required.
2. **Subdomain routing (placeholder, inert)** — the `admin.*` → `/admin/:splat`, `admin.*` → `/admin/login`, and `hotel.*` → `/admin/pin` rules from `netlify.toml` are reproduced using the literal placeholder domain `example.com`, per Cloudflare's `_redirects` requirement for literal hostnames (no wildcard-apex matching like Netlify's `admin.*`). **These lines are commented out** so they cannot match any real hostname by construction — a request to `admin.example.com` today is simply unreachable (no real DNS points there), not an error, and cannot accidentally intercept real production traffic.

### Before first production deploy

Edit `public/_redirects`: uncomment the subdomain block and replace every `example.com` with the real production domain. Until this is done, the site serves the same SPA at every hostname it receives — a safe, non-broken default — rather than routing `admin.`/`hotel.` subdomains anywhere special.

## 5. Housekeeping cron Worker — deploy sequence

`workers/housekeeping-cron/` is a second, independently deployed artifact with its own `tsconfig.json`/`package.json`. It is **not** covered by the root `pnpm run build` / `pnpm run typecheck` scripts.

```
cd workers/housekeeping-cron
npx wrangler secret put FIREBASE_SERVICE_ACCOUNT_KEY
npx wrangler deploy
```

Worker secrets are configured independently from the Pages project's environment variables, even though the value (`FIREBASE_SERVICE_ACCOUNT_KEY`) is identical to what's set in the Pages dashboard.

## 6. Environment variables

### Server-side secrets (Cloudflare Pages → Settings → Environment variables and secrets, type **Secret**)

| Variable | Notes |
|---|---|
| `FIREBASE_SERVICE_ACCOUNT_KEY` | Required. Base64-encoded service account JSON, read by `functions/_shared/firebaseRest.ts`. |
| `FIREBASE_DATABASE_URL` | Optional. Kept for parity with the old Netlify env var name — **not currently read by any server function** (confirmed against `functions/_shared/firebaseRest.ts`); don't spend time chasing it if it's unset. |

### Build-time client variables (type **Environment variable**, applied at build time, must be prefixed `VITE_`)

| Variable | Notes |
|---|---|
| `VITE_SUPABASE_URL` | Required, no fallback (confirmed in `src/lib/supabase.ts`). |
| `VITE_SUPABASE_ANON_KEY` | Required, no fallback (confirmed in `src/lib/supabase.ts`). |
| `VITE_FIREBASE_VAPID_KEY` | Required for web push, no fallback. |
| `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`, `VITE_FIREBASE_PROJECT_ID`, `VITE_FIREBASE_STORAGE_BUCKET`, `VITE_FIREBASE_MESSAGING_SENDER_ID`, `VITE_FIREBASE_APP_ID`, `VITE_FIREBASE_MEASUREMENT_ID`, `VITE_FIREBASE_DATABASE_URL` | All have hardcoded fallback values in `src/lib/firebase.ts` today, so the app keeps working even if unset. This fallback behavior is addressed in Phase 3 (item H-3) — **not changed in this phase**, documented here as the current, accurate state only. |

Cloudflare Pages environment variables are scoped **per environment** (Production vs. Preview) — set them in both if preview deploys are expected to work.

## 7. Deep-link / SPA-routing check (§8 of the Phase 1 prompt)

The following client-side routes were confirmed to exist in `src/App.tsx`'s wouter route table, and therefore resolve correctly on a fresh page load via the `_redirects` SPA catch-all (which routes any unmatched path to `index.html`, letting wouter take over client-side):

| Route | Confirmed in `src/App.tsx` |
|---|---|
| `/admin/pin` | Yes — `PinLoginPage` |
| `/booking/confirmation?id=X&name=Y&amount=Z` | Yes — `/booking/confirmation`, query string is not part of path matching |
| `/rooms` | Yes — `RoomsPage` |
| `/admin/login` | Yes — `AdminLoginPage` |
| `/admin` | Yes — redirects client-side to `/admin/dashboard` |

**Note:** this was verified by static inspection of the route table, not by an actual served build — see §9 "Known build/verification issues" below.

## 8. Known build/verification issues

The sandbox this Phase 1 pass was executed in has **no outbound network access**, so the following required verification steps (§10 of the Phase 1 prompt) could **not** be run here and must be run by whoever applies these changes, before considering Phase 1 complete:

1. `pnpm install` at the repo root, then `pnpm run typecheck` — must exit 0.
2. `pnpm run build` — must exit 0 and produce `dist/public/` containing `_headers`, `_redirects`, `index.html`, and a hashed `assets/` directory.
3. Diff the built `dist/public/_headers` and `dist/public/_redirects` against the (now-deleted) original `netlify.toml` content preserved in this document's §3–4, to confirm nothing was dropped.
4. From `workers/housekeeping-cron/`, run `pnpm install` and `npx tsc --noEmit` — must exit 0.
5. `grep -ri netlify` across the repo after this change and confirm every remaining hit is a historical/changelog reference inside `MIGRATION.md` or a generic prose mention (not a broken file-path reference) — five stale comments that pointed at nonexistent `netlify/functions/...` paths have already been corrected as part of this pass (see §9).

These steps were not skipped by choice — `npm install -g pnpm` was attempted and failed with a `403 Forbidden` from the registry, confirming no registry access in this environment. All file-based work below was completed and is believed correct by direct source inspection, but is **unverified by an actual build** until someone runs the above in an environment with network access (e.g. Replit or a CI runner).

## 9. Stale-comment fixes (Phase 1 prompt §10, item 5)

Five comments referenced Netlify file paths (`netlify/functions/...`) that no longer exist in the repository (there is no `netlify/` directory). Per the Phase 1 prompt, these are corrected — comment text only, no logic touched:

- `src/lib/housekeepingSchedule.ts` — updated to point at `functions/_shared/housekeepingQueue.ts` / `workers/housekeeping-cron/`.
- `src/lib/housekeeping.ts` — same.
- `src/lib/notifications.ts` — same, plus clarified it's the housekeeping-cron Worker, not a generic "Netlify scheduled function."
- `src/lib/auth.ts` — updated to point at `functions/api/verify-pin.ts`.
- `functions/_shared/admin.ts` — reworded to no longer reference a `netlify/functions/_shared/admin.ts` path.

Remaining "Netlify" mentions elsewhere in the repo (e.g. in `MIGRATION.md`, or generic prose like "Netlify function" in `src/lib/diagnostics.ts` error-copy, `src/lib/push.ts`, `src/lib/bugTracker.ts`, `src/lib/supabase.ts`, and `vitest.config.ts`'s unmatched `netlify/**/*.test.ts` test-file glob) do not point at a broken file path — they're historical/changelog references or generic prose that doesn't mislead a reader about where code actually lives. Per the Phase 1 prompt's scope, these were left untouched; `vitest.config.ts`'s glob is harmless (it matches nothing, since no `netlify/` directory exists) but is flagged here for awareness in case a future phase wants to clean it up.
