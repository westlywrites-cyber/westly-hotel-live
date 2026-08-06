import { addDoc, collection, serverTimestamp } from "firebase/firestore";
import { db } from "./firebase";

// ══════════════════════════════════════════════════════════════════════════
// APPLICATION DIAGNOSTICS & ERROR MONITORING
//
// Single write path for every error the app can detect — render crashes,
// JS runtime errors, API/Firebase/Supabase failures, auth/permission
// denials, failed uploads, routing misses, and performance issues — into
// the `diagnostic_logs` Firestore collection. The Super Admin Diagnostics
// Dashboard (src/pages/admin/DiagnosticsPage.tsx) reads that collection;
// normal users never see any of this, they only ever see the friendly
// fallback UI (ErrorBoundary / DataError).
//
// DESIGN NOTES
//   • captureError() NEVER throws and NEVER blocks the caller — a broken
//     diagnostics write must never break the feature that triggered it.
//   • Client-side throttling (dedupe + a per-minute cap) stops a repeating
//     failure (e.g. a listener retrying every few seconds) from flooding
//     Firestore with near-duplicate documents.
//   • Writes are allowed from signed-out sessions too (see firestore.rules)
//     because guest-facing pages — booking, room browsing — can fail before
//     any admin auth exists. Reading the collection back is Super Admin only.
// ══════════════════════════════════════════════════════════════════════════

export type ErrorSeverity = "info" | "warning" | "error" | "critical";

export type ErrorCategory =
  | "render"               // component failed to render (ErrorBoundary)
  | "javascript"           // uncaught JS runtime error / unhandled rejection
  | "console"              // console.error / console.warn calls
  | "api"                  // Netlify function / REST API request failure
  | "firebase_auth"        // authentication / authorization errors
  | "firestore_permission" // Firestore permission-denied
  | "firestore_query"      // Firestore query / listener failure
  | "realtime_sync"        // Realtime Database sync issues
  | "supabase"             // Supabase connection errors
  | "image_upload"
  | "file_upload"
  | "network"              // connectivity problems
  | "routing"              // unknown route / navigation failure
  | "performance"          // slow load / long task
  | "background_job"       // failed scheduled task / queue run
  | "ui_issue"             // broken layout, overflow, missing states, broken images
  | "ux_issue"             // confusing/incomplete interaction flows
  | "stuck_loading"        // operation never exited its loading state
  | "other";

export interface DiagnosticContext {
  userId?: string | null;
  userName?: string | null;
  userRole?: string | null;
}

export interface DiagnosticLogInput {
  /** The exact error message. */
  message: string;
  category: ErrorCategory;
  severity?: ErrorSeverity;
  /** The file, component, or module where the error occurred. */
  source?: string;
  /** The function or process that triggered the error. */
  action?: string;
  stack?: string;
  /** Root cause, if it can be determined (e.g. a Firebase error code). */
  rootCause?: string;
  /** Suggested troubleshooting steps. Auto-derived from category/rootCause if omitted. */
  suggestion?: string;
  metadata?: Record<string, unknown>;
}

// ── Session context (who's currently signed in) ─────────────────────────────
// Set by AuthContext whenever the resolved admin user changes, so every
// error captured after that point is automatically attributed to the
// affected user role without every call site having to pass it in.
let context: DiagnosticContext = {};

export function setDiagnosticsContext(ctx: DiagnosticContext) {
  context = { ...context, ...ctx };
}

export function clearDiagnosticsContext() {
  context = {};
}

// ── Throttling ────────────────────────────────────────────────────────────
const DEDUPE_WINDOW_MS = 30_000; // same error signature within 30s → skip
const MAX_LOGS_PER_MINUTE = 20;  // hard cap so a runaway loop can't flood Firestore

const recentSignatures = new Map<string, number>();
let recentTimestamps: number[] = [];

function shouldLog(signature: string): boolean {
  const now = Date.now();
  recentTimestamps = recentTimestamps.filter((t) => now - t < 60_000);
  if (recentTimestamps.length >= MAX_LOGS_PER_MINUTE) return false;

  const last = recentSignatures.get(signature);
  if (last && now - last < DEDUPE_WINDOW_MS) return false;

  recentSignatures.set(signature, now);
  recentTimestamps.push(now);
  // Keep the signature map from growing unbounded over a long session.
  if (recentSignatures.size > 200) {
    const cutoff = now - DEDUPE_WINDOW_MS;
    for (const [key, ts] of recentSignatures) {
      if (ts < cutoff) recentSignatures.delete(key);
    }
  }
  return true;
}

// ── Browser / device info ────────────────────────────────────────────────
function getBrowserInfo(): Record<string, unknown> | null {
  if (typeof navigator === "undefined") return null;
  return {
    userAgent: navigator.userAgent,
    language: navigator.language,
    online: navigator.onLine,
    viewport: typeof window !== "undefined" ? `${window.innerWidth}x${window.innerHeight}` : null,
  };
}

// ── Suggested-fix lookup ─────────────────────────────────────────────────
// Best-effort, pattern-matched troubleshooting hints for the developer
// reading the dashboard — not shown to normal users.
function deriveSuggestion(category: ErrorCategory, message: string, rootCause?: string): string {
  const text = `${rootCause ?? ""} ${message}`.toLowerCase();

  if (text.includes("permission-denied") || text.includes("permission_denied")) {
    return "Check firestore.rules for this collection/action and confirm the signed-in user's role and status field match what the rule expects.";
  }
  if (text.includes("unauthenticated")) {
    return "The request was made without a valid Firebase Auth session — check that the ID token is still valid and being sent.";
  }
  if (text.includes("failed-precondition") && text.includes("index")) {
    return "Firestore needs a composite index for this query — open the link in the raw error (server logs) or add it in firestore.indexes.json.";
  }
  if (text.includes("unavailable") || text.includes("network") || text.includes("failed to fetch")) {
    return "Likely a connectivity issue — confirm the device is online and Firebase/Supabase status pages show no outage. Firestore listeners auto-retry; this may self-resolve.";
  }
  if (text.includes("quota") || text.includes("resource-exhausted")) {
    return "A usage quota was hit (Firebase/Supabase plan limits). Check the project's usage dashboard.";
  }
  if (category === "image_upload" || category === "file_upload") {
    return "Confirm Supabase Storage is configured (VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY) and the file meets the size/type limits in src/lib/storage.ts.";
  }
  if (category === "firebase_auth") {
    return "Check the user's account status in Users & Roles, and confirm they're using the correct login method (PIN vs email/password) for their role.";
  }
  if (category === "routing") {
    return "A user hit a URL with no matching route — check for a stale link, bookmark, or a recently renamed/removed route in src/App.tsx.";
  }
  if (category === "performance") {
    return "Investigate slow queries, large unpaginated collections, or large uploaded images on this page.";
  }
  if (category === "background_job") {
    return "Re-run the job manually from its admin page and check the corresponding Netlify function log for the underlying failure.";
  }
  if (category === "render") {
    return "Check the component stack below for the exact component that threw, and look for undefined data being accessed before a Firestore listener has loaded.";
  }
  if (category === "stuck_loading") {
    return "This action's loading state outlived its own operation. Check that every code path (success, error, and early return) reaches a `finally` that clears the loading flag, and that the underlying promise actually settles — wrap it with withTimeout() from src/lib/utils.ts, or migrate the handler to useAsyncAction() in src/hooks/useAsyncAction.ts, which does this automatically.";
  }
  if (category === "ui_issue") {
    return "Check the affected route at the recorded viewport width — likely a fixed-width element, missing responsive class, or a broken image URL.";
  }
  if (category === "ux_issue") {
    return "Review the interaction flow on the affected route for a missing loading/empty/success/error state — see if useAsyncAction() should back this action instead.";
  }
  if (category === "console") {
    return "Check the browser console for full context around this message — repeated console errors often indicate a state update on an unmounted component or a missing null-check.";
  }
  return "Reproduce the action and check the browser console / Netlify function logs for the full stack trace.";
}

// ── Core write path ───────────────────────────────────────────────────────
export async function captureError(input: DiagnosticLogInput): Promise<void> {
  try {
    const severity = input.severity ?? "error";
    const signature = `${input.category}:${input.source ?? ""}:${input.message}`.slice(0, 300);
    if (!shouldLog(signature)) return;

    await addDoc(collection(db, "diagnostic_logs"), {
      message: (input.message || "Unknown error").slice(0, 2000),
      category: input.category,
      severity,
      source: input.source ?? null,
      action: input.action ?? null,
      stack: input.stack ? input.stack.slice(0, 4000) : null,
      rootCause: input.rootCause ?? null,
      suggestion: input.suggestion ?? deriveSuggestion(input.category, input.message, input.rootCause),
      metadata: input.metadata ?? null,
      route: typeof window !== "undefined" ? window.location.pathname : null,
      userId: context.userId ?? null,
      userName: context.userName ?? null,
      userRole: context.userRole ?? null,
      browser: getBrowserInfo(),
      resolved: false,
      timestamp: serverTimestamp(),
    });
  } catch (err) {
    // Diagnostics must never throw or recurse into itself.
    console.error("[Diagnostics] Failed to write diagnostic log:", err);
  }
}

// ── Convenience wrappers for each error type in the spec ────────────────
export function logRenderError(error: Error, componentStack: string | null | undefined, componentLabel?: string) {
  return captureError({
    message: error.message,
    category: "render",
    severity: "error",
    source: componentLabel,
    action: "React render",
    stack: componentStack || error.stack,
    rootCause: error.name,
  });
}

export function logJavaScriptError(message: string, stack?: string, source?: string) {
  return captureError({
    message,
    category: "javascript",
    severity: "error",
    source,
    stack,
  });
}

export function logApiError(endpoint: string, error: unknown, action?: string) {
  const message = error instanceof Error ? error.message : String(error);
  return captureError({
    message,
    category: "api",
    severity: "error",
    source: `/api/${endpoint}`,
    action,
    stack: error instanceof Error ? error.stack : undefined,
  });
}

export function logFirestoreError(
  operation: "query" | "permission",
  collectionName: string,
  error: { code?: string; message?: string } | Error,
  action?: string
) {
  const code = (error as any)?.code as string | undefined;
  const isPermission = code === "permission-denied" || operation === "permission";
  const severity: ErrorSeverity = isPermission ? "warning" : "error";
  return captureError({
    message: error.message || "Firestore operation failed",
    category: isPermission ? "firestore_permission" : "firestore_query",
    severity,
    source: `Firestore: ${collectionName}`,
    action,
    rootCause: code,
  });
}

export function logAuthError(error: { code?: string; message?: string } | Error, action?: string) {
  return captureError({
    message: error.message || "Authentication failed",
    category: "firebase_auth",
    severity: "warning",
    action,
    rootCause: (error as any)?.code,
  });
}

export function logUploadError(kind: "image_upload" | "file_upload", error: unknown, folder?: string) {
  const message = error instanceof Error ? error.message : String(error);
  return captureError({
    message,
    category: kind,
    severity: "warning",
    source: folder ? `Upload: ${folder}` : "Upload",
  });
}

export function logRealtimeSyncError(error: { code?: string; message?: string } | Error, path?: string) {
  return captureError({
    message: error.message || "Realtime sync failed",
    category: "realtime_sync",
    severity: "warning",
    source: path,
    rootCause: (error as any)?.code,
  });
}

export function logRoutingError(path: string) {
  return captureError({
    message: `No route matched "${path}"`,
    category: "routing",
    severity: "info",
    source: path,
  });
}

export function logPerformanceIssue(metric: string, valueMs: number, thresholdMs: number, page?: string) {
  return captureError({
    message: `${metric} took ${Math.round(valueMs)}ms (threshold ${thresholdMs}ms)`,
    category: "performance",
    severity: valueMs > thresholdMs * 2 ? "warning" : "info",
    source: page,
    metadata: { metric, valueMs, thresholdMs },
  });
}

export function logBackgroundJobFailure(jobName: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return captureError({
    message,
    category: "background_job",
    severity: "error",
    source: jobName,
  });
}

export function logNetworkOffline() {
  return captureError({
    message: "Device went offline",
    category: "network",
    severity: "warning",
  });
}

// ── UI / UX issue reporting ──────────────────────────────────────────────
export function logUiIssue(message: string, source?: string, metadata?: Record<string, unknown>) {
  return captureError({
    message,
    category: "ui_issue",
    severity: "warning",
    source,
    metadata,
  });
}

export function logUxIssue(message: string, source?: string, action?: string, metadata?: Record<string, unknown>) {
  return captureError({
    message,
    category: "ux_issue",
    severity: "info",
    source,
    action,
    metadata,
  });
}

/**
 * Reports a "stuck on Processing…" bug: a loading state that outlived its
 * own operation. This is the single most requested diagnostic — call it
 * whenever a tracked operation blows past its expected duration without
 * resolving OR rejecting. useAsyncAction() (src/hooks/useAsyncAction.ts)
 * calls this automatically; call it directly from any hand-rolled loading
 * state (e.g. a `setTimeout` watchdog around a manual `setLoading(true)`).
 */
export function logStuckLoading(operation: string, elapsedMs: number, source?: string, metadata?: Record<string, unknown>) {
  return captureError({
    message: `"${operation}" is still in a loading state after ${Math.round(elapsedMs / 1000)}s — the operation may have completed or failed without updating the UI.`,
    category: "stuck_loading",
    severity: "error",
    source,
    action: operation,
    metadata: { elapsedMs, ...metadata },
  });
}

// ── Stuck-operation watchdog registry ────────────────────────────────────
// A lightweight, framework-agnostic way to flag any async operation that
// never reaches a resolved/rejected end state within a reasonable window —
// independent of React re-renders, so it still fires even if the component
// that started the operation has already unmounted (which is itself often
// *why* the UI looks stuck: the state update landed on a gone component).
const activeOperations = new Map<string, { operation: string; source?: string; startedAt: number; timer: ReturnType<typeof setTimeout> }>();
let opCounter = 0;

/** Call when a tracked async operation starts. Returns a token for endOperation(). */
export function startOperation(operation: string, source?: string, timeoutMs = 20_000): string {
  const token = `op_${++opCounter}_${Date.now()}`;
  const startedAt = Date.now();
  const timer = setTimeout(() => {
    if (activeOperations.has(token)) {
      logStuckLoading(operation, Date.now() - startedAt, source);
    }
  }, timeoutMs);
  activeOperations.set(token, { operation, source, startedAt, timer });
  return token;
}

/** Call when a tracked async operation settles (success OR failure). */
export function endOperation(token: string) {
  const entry = activeOperations.get(token);
  if (!entry) return;
  clearTimeout(entry.timer);
  activeOperations.delete(token);
}

/**
 * Wraps any promise (component handler, service function, background job)
 * with the stuck-operation watchdog, without needing a React hook. Use this
 * in non-component code such as src/lib/*.ts service functions.
 */
export async function traceAsync<T>(operation: string, promise: Promise<T>, source?: string, timeoutMs = 20_000): Promise<T> {
  const token = startOperation(operation, source, timeoutMs);
  try {
    return await promise;
  } finally {
    endOperation(token);
  }
}

// ── Global handlers ───────────────────────────────────────────────────────
// Catches errors OUTSIDE React's render cycle (ErrorBoundary only catches
// render-time errors) — e.g. errors thrown from event handlers, timers, or
// unhandled promise rejections — which would otherwise only ever show up
// as a silent console error with nothing recorded for the dashboard.
let installed = false;

export function installGlobalDiagnostics() {
  if (installed || typeof window === "undefined") return;
  installed = true;

  window.addEventListener("error", (event) => {
    logJavaScriptError(
      event.message || "Unhandled error",
      event.error?.stack,
      event.filename ? `${event.filename}:${event.lineno}:${event.colno}` : undefined
    );
  });

  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason;
    const message = reason instanceof Error ? reason.message : String(reason ?? "Unhandled promise rejection");
    logJavaScriptError(message, reason instanceof Error ? reason.stack : undefined, "unhandledrejection");
  });

  window.addEventListener("offline", () => {
    logNetworkOffline();
  });

  // Basic page-load performance check — fires once per navigation.
  window.addEventListener("load", () => {
    setTimeout(() => {
      try {
        const [nav] = performance.getEntriesByType("navigation") as PerformanceNavigationTiming[];
        if (nav) {
          const loadTime = nav.loadEventEnd - nav.startTime;
          const THRESHOLD_MS = 5000;
          if (loadTime > THRESHOLD_MS) {
            logPerformanceIssue("Page load", loadTime, THRESHOLD_MS, window.location.pathname);
          }
        }
      } catch {
        // performance API not available — not worth reporting
      }
    }, 0);
  });

  installUiUxDetectors();
}

// ── Passive UI / UX / console detectors ──────────────────────────────────
// These only ever OBSERVE (event listeners / a single low-frequency
// PerformanceObserver) — nothing here touches the DOM, patches user code,
// or adds any work to the render path, so the performance cost is
// negligible even on low-end devices.
function installUiUxDetectors() {
  // Broken images — the #1 "component failed to load" signal available
  // generically across every page without per-component instrumentation.
  // Must use the capture phase: resource load errors don't bubble.
  window.addEventListener(
    "error",
    (event) => {
      const target = event.target as HTMLElement | null;
      if (target && target instanceof HTMLImageElement) {
        logUiIssue(
          `Image failed to load: ${target.currentSrc || target.src || "(no src)"}`,
          window.location.pathname,
          { alt: target.alt || null }
        );
      }
    },
    true
  );

  // Console capture — funnels console.error / console.warn into the
  // dashboard so they aren't silently lost outside DevTools. Wrapped so a
  // failure here can never recurse or throw.
  const origError = console.error;
  const origWarn = console.warn;
  console.error = (...args: unknown[]) => {
    try {
      const message = args.map((a) => (a instanceof Error ? a.message : String(a))).join(" ").slice(0, 500);
      // Never capture diagnostics' own internal failure log — that would
      // feed a failed write straight back into another write attempt.
      if (!message.startsWith("[Diagnostics]")) {
        captureError({ message, category: "console", severity: "error", source: window.location.pathname, action: "console.error" });
      }
    } catch {
      // never let capture break the original console call
    }
    origError.apply(console, args as any);
  };
  console.warn = (...args: unknown[]) => {
    try {
      const message = args.map((a) => (a instanceof Error ? a.message : String(a))).join(" ").slice(0, 500);
      captureError({ message, category: "console", severity: "info", source: window.location.pathname, action: "console.warn" });
    } catch {
      // never let capture break the original console call
    }
    origWarn.apply(console, args as any);
  };

  // Responsive/broken-layout heuristic — the page shouldn't force
  // horizontal scrolling on its own root. Debounced and only checked on
  // resize (plus one initial check after layout settles), so this never
  // runs on a hot path like scroll or render.
  let overflowTimer: ReturnType<typeof setTimeout> | undefined;
  const checkOverflow = () => {
    try {
      const root = document.documentElement;
      const overflowPx = root.scrollWidth - window.innerWidth;
      if (overflowPx > 24) {
        logUiIssue(
          `Horizontal overflow detected (page is ${overflowPx}px wider than the viewport)`,
          window.location.pathname,
          { viewport: `${window.innerWidth}x${window.innerHeight}`, overflowPx }
        );
      }
    } catch {
      // ignore
    }
  };
  window.addEventListener("resize", () => {
    clearTimeout(overflowTimer);
    overflowTimer = setTimeout(checkOverflow, 500);
  });
  setTimeout(checkOverflow, 2000);

  // Long-task detection — a real, measurable performance bottleneck signal
  // (any task blocking the main thread for 200ms+ is felt as UI jank/
  // unresponsive buttons). Feature-detected since not every browser
  // supports the 'longtask' entry type.
  try {
    if ("PerformanceObserver" in window) {
      const supported = (PerformanceObserver as any).supportedEntryTypes as string[] | undefined;
      if (!supported || supported.includes("longtask")) {
        const po = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            if (entry.duration >= 200) {
              logPerformanceIssue("Long main-thread task", entry.duration, 200, window.location.pathname);
            }
          }
        });
        po.observe({ entryTypes: ["longtask"] });
      }
    }
  } catch {
    // longtask unsupported — skip silently
  }
}
