import {
  addDoc, updateDoc, doc, collection, serverTimestamp, setDoc, increment,
  writeBatch,
} from "firebase/firestore";
import { ref, set, remove, onDisconnect, serverTimestamp as rtdbServerTimestamp } from "firebase/database";
import { db, rtdb } from "./firebase";

// ══════════════════════════════════════════════════════════════════════════
// USER ACTIVITY & USAGE ANALYTICS
//
// Single write path for page-view navigation, search queries, and
// meaningful interactions, plus session/presence bookkeeping. Feeds the
// Super Admin Analytics dashboard (src/pages/admin/AnalyticsPage.tsx).
// No other page ever reads these collections.
//
// DESIGN NOTES (mirrors src/lib/diagnostics.ts, the app's other
// "everything funnels through one write path" system):
//   • Every exported function is fire-and-forget and NEVER throws — a
//     broken analytics write must never break the feature that triggered
//     it or surface to the user.
//   • Writes are allowed from signed-out sessions too, because the public
//     guest site (booking, room browsing) is exactly the traffic the
//     Super Admin wants visibility into, alongside the authenticated
//     admin/staff areas.
//   • Client-side batching + dedupe keeps this from writing a document for
//     every trivial UI event — interactions and searches are queued and
//     flushed on an interval, not written one-by-one.
//   • Never logs passwords, tokens, API keys, payment details, or raw form
//     contents — only page paths, search query text (from the small set of
//     dedicated search inputs), and named action/module labels.
// ══════════════════════════════════════════════════════════════════════════

export interface AnalyticsContext {
  userId?: string | null;
  userName?: string | null;
  userRole?: string | null;
}

let context: AnalyticsContext = {};

/** Called by AuthContext whenever the resolved admin user changes. */
export function setAnalyticsContext(ctx: AnalyticsContext) {
  context = { ...context, ...ctx };
  ensureSession();
}

/** Called on sign-out — ends the session and clears attribution. */
export function clearAnalyticsContext() {
  endSession();
  context = {};
}

// ── Session identity ─────────────────────────────────────────────────────
// One session per browser tab lifetime (sessionStorage, not localStorage),
// matching how a "session" is understood throughout the rest of the spec —
// a fresh tab/visit is a new session, a reload within the same tab is not.
const SESSION_KEY = "wh_analytics_session_id";
const PAGE_INDEX_KEY = "wh_analytics_page_index";

function getSessionId(): string {
  if (typeof sessionStorage === "undefined") return "no-session";
  let id = sessionStorage.getItem(SESSION_KEY);
  if (!id) {
    id = `sess_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    sessionStorage.setItem(SESSION_KEY, id);
    sessionStorage.setItem(PAGE_INDEX_KEY, "0");
  }
  return id;
}

function nextPageIndex(): number {
  if (typeof sessionStorage === "undefined") return 0;
  const n = Number(sessionStorage.getItem(PAGE_INDEX_KEY) || "0") + 1;
  sessionStorage.setItem(PAGE_INDEX_KEY, String(n));
  return n;
}

function detectDeviceType(): "mobile" | "tablet" | "desktop" {
  if (typeof navigator === "undefined") return "desktop";
  const w = typeof window !== "undefined" ? window.innerWidth : 1280;
  const ua = navigator.userAgent || "";
  if (/tablet|ipad/i.test(ua) || (w >= 600 && w < 1024 && /mobile/i.test(ua))) return "tablet";
  if (/mobile|android|iphone/i.test(ua) || w < 600) return "mobile";
  return "desktop";
}

let sessionStarted = false;
const SESSION_CREATED_KEY = "wh_analytics_session_created";

/**
 * Creates the session document the first time it's needed (idempotent for
 * the tab's whole lifetime). Uses a sessionStorage flag rather than just an
 * in-memory guard, because the in-memory flag resets on every page reload
 * but the sessionId itself persists — without the persisted flag, a reload
 * would re-attempt a "create" write on an already-existing document, which
 * Firestore rules treat as an update and reject (identity fields like
 * userId/userRole are only writable at creation — see firestore.rules).
 */
function ensureSession() {
  if (sessionStarted || typeof window === "undefined") return;
  sessionStarted = true;
  if (sessionStorage.getItem(SESSION_CREATED_KEY) === "1") return; // already created earlier this tab session

  const sessionId = getSessionId();
  setDoc(doc(db, "analytics_sessions", sessionId), {
    sessionId,
    userId: context.userId ?? null,
    userName: context.userName ?? null,
    userRole: context.userRole ?? null,
    startedAt: serverTimestamp(),
    lastActiveAt: serverTimestamp(),
    endedAt: null,
    pageViewCount: 1, // counts the entry page itself — see trackPageView()
    entryPage: window.location.pathname,
    exitPage: window.location.pathname,
    deviceType: detectDeviceType(),
    isPublic: !window.location.pathname.startsWith("/admin"),
  })
    .then(() => sessionStorage.setItem(SESSION_CREATED_KEY, "1"))
    .catch((err) => console.warn("[Analytics] Failed to start session:", err));
}

function touchSession(exitPage: string) {
  const sessionId = getSessionId();
  updateDoc(doc(db, "analytics_sessions", sessionId), {
    lastActiveAt: serverTimestamp(),
    exitPage,
    pageViewCount: increment(1),
  }).catch((err) => console.warn("[Analytics] Failed to update session:", err));
}

function endSession() {
  if (typeof sessionStorage === "undefined") return;
  const sessionId = sessionStorage.getItem(SESSION_KEY);
  if (!sessionId) return;
  updateDoc(doc(db, "analytics_sessions", sessionId), {
    endedAt: serverTimestamp(),
    lastActiveAt: serverTimestamp(),
  }).catch(() => {});
  removePresence();
}

// ── Page view tracking ───────────────────────────────────────────────────
let currentPageViewId: string | null = null;
let currentPageEnteredAt = 0;
let lastPage: string | null = null;

/**
 * Record a page visit. Call once per navigation (route change). Closes out
 * the previous page view with its time-on-page before opening the new one.
 */
export function trackPageView(page: string, pageLabel?: string) {
  try {
    // Must run before nextPageIndex() so the very first page of a brand
    // new session is the one whose entryIndex comes back as 1.
    const isNewSession = typeof sessionStorage !== "undefined" && sessionStorage.getItem(SESSION_CREATED_KEY) !== "1";
    ensureSession();
    const sessionId = getSessionId();
    const now = Date.now();

    // Close out the previous page view with how long the user spent on it.
    if (currentPageViewId && currentPageEnteredAt) {
      const durationMs = now - currentPageEnteredAt;
      const prevId = currentPageViewId;
      updateDoc(doc(db, "analytics_page_views", prevId), { durationMs }).catch(() => {});
    }

    currentPageEnteredAt = now;
    const previousPage = lastPage;
    lastPage = page;
    const entryIndex = nextPageIndex();

    addDoc(collection(db, "analytics_page_views"), {
      sessionId,
      userId: context.userId ?? null,
      userName: context.userName ?? null,
      userRole: context.userRole ?? null,
      page,
      pageLabel: pageLabel ?? page,
      previousPage: previousPage ?? null,
      entryIndex,
      timestamp: serverTimestamp(),
    })
      .then((ref) => {
        currentPageViewId = ref.id;
      })
      .catch((err) => console.warn("[Analytics] Failed to record page view:", err));

    // The entry page's count/lastActiveAt/exitPage are already set by
    // ensureSession()'s creation write — touching again here would race the
    // still-in-flight create and fail. Every page after that goes through
    // the normal update path.
    if (!isNewSession || entryIndex > 1) touchSession(page);
    updatePresence(page);
  } catch (err) {
    console.warn("[Analytics] trackPageView failed:", err);
  }
}

/** Flushes the current page's duration immediately (call on tab close/hide). */
export function flushCurrentPageDuration() {
  if (!currentPageViewId || !currentPageEnteredAt) return;
  const durationMs = Date.now() - currentPageEnteredAt;
  updateDoc(doc(db, "analytics_page_views", currentPageViewId), { durationMs }).catch(() => {});
}

// ── Search query logging ─────────────────────────────────────────────────
const recentSearches = new Map<string, number>();
const SEARCH_DEDUPE_MS = 4000;

/**
 * Record a search performed within the app. Debounce at the call site
 * (search inputs already do this); this function additionally dedupes
 * identical queries fired in quick succession from the same module.
 */
export function trackSearch(searchQuery: string, module: string, resultsCount?: number) {
  const q = (searchQuery || "").trim();
  if (q.length < 2) return; // ignore empty/near-empty queries — not useful signal
  try {
    const key = `${module}:${q.toLowerCase()}`;
    const now = Date.now();
    const last = recentSearches.get(key);
    if (last && now - last < SEARCH_DEDUPE_MS) return;
    recentSearches.set(key, now);
    if (recentSearches.size > 200) {
      const cutoff = now - SEARCH_DEDUPE_MS;
      for (const [k, t] of recentSearches) if (t < cutoff) recentSearches.delete(k);
    }

    addDoc(collection(db, "analytics_search_logs"), {
      sessionId: getSessionId(),
      userId: context.userId ?? null,
      userName: context.userName ?? null,
      userRole: context.userRole ?? null,
      query: q.slice(0, 200),
      module,
      resultsCount: typeof resultsCount === "number" ? resultsCount : null,
      timestamp: serverTimestamp(),
    }).catch((err) => console.warn("[Analytics] Failed to record search:", err));
  } catch (err) {
    console.warn("[Analytics] trackSearch failed:", err);
  }
}

// ── Interaction tracking (clicks, form submits, tabs, filters) ──────────
const recentInteractions = new Map<string, number>();
const INTERACTION_DEDUPE_MS = 1500;
let interactionQueue: Record<string, unknown>[] = [];
let flushTimer: ReturnType<typeof setInterval> | null = null;

function scheduleFlush() {
  if (flushTimer || typeof window === "undefined") return;
  flushTimer = setInterval(flushInteractionQueue, 8000);
}

function flushInteractionQueue() {
  if (interactionQueue.length === 0) return;
  const batchItems = interactionQueue.splice(0, 400); // stay well under Firestore's 500-write batch cap
  const batch = writeBatch(db);
  for (const item of batchItems) {
    const ref = doc(collection(db, "analytics_interactions"));
    batch.set(ref, item);
  }
  batch.commit().catch((err) => console.warn("[Analytics] Failed to flush interactions:", err));
}

/**
 * Record a meaningful interaction: a button click, tab open, filter
 * change, or completed action. Batched and flushed periodically rather
 * than written immediately, and deduped so rapid repeats of the same
 * action collapse into one record.
 */
export function trackInteraction(action: string, module: string, status?: string) {
  try {
    const key = `${module}:${action}:${status ?? ""}`;
    const now = Date.now();
    const last = recentInteractions.get(key);
    if (last && now - last < INTERACTION_DEDUPE_MS) return;
    recentInteractions.set(key, now);
    if (recentInteractions.size > 300) {
      const cutoff = now - INTERACTION_DEDUPE_MS;
      for (const [k, t] of recentInteractions) if (t < cutoff) recentInteractions.delete(k);
    }

    interactionQueue.push({
      sessionId: getSessionId(),
      userId: context.userId ?? null,
      userName: context.userName ?? null,
      userRole: context.userRole ?? null,
      action: action.slice(0, 150),
      module,
      page: typeof window !== "undefined" ? window.location.pathname : null,
      status: status ?? null,
      timestamp: serverTimestamp(),
    });
    scheduleFlush();
    if (interactionQueue.length >= 50) flushInteractionQueue(); // don't let the queue grow unbounded on a busy page
  } catch (err) {
    console.warn("[Analytics] trackInteraction failed:", err);
  }
}

// ── Real-time presence (Realtime Database) ───────────────────────────────
// Mirrors the existing roomStatus/activity_feed pattern in
// src/hooks/useRealtime.ts. onDisconnect() means a closed tab or lost
// connection removes the presence entry automatically — no stale
// "currently active" ghosts to clean up.
let presenceHeartbeat: ReturnType<typeof setInterval> | null = null;

function updatePresence(page: string) {
  if (typeof window === "undefined") return;
  const sessionId = getSessionId();
  const presenceRef = ref(rtdb, `presence/${sessionId}`);
  const payload = {
    userId: context.userId ?? null,
    userName: context.userName ?? "Guest",
    userRole: context.userRole ?? "guest",
    page,
    lastActiveAt: rtdbServerTimestamp(),
  };
  set(presenceRef, payload).catch(() => {});
  onDisconnect(presenceRef).remove().catch(() => {});

  if (!presenceHeartbeat) {
    // Periodic heartbeat keeps lastActiveAt fresh even if the user sits on
    // one page without navigating, so "currently active" doesn't go stale.
    presenceHeartbeat = setInterval(() => {
      set(presenceRef, { ...payload, page: lastPage ?? page, lastActiveAt: rtdbServerTimestamp() }).catch(() => {});
    }, 30_000);
  }
}

function removePresence() {
  if (typeof sessionStorage === "undefined") return;
  const sessionId = sessionStorage.getItem(SESSION_KEY);
  if (!sessionId) return;
  remove(ref(rtdb, `presence/${sessionId}`)).catch(() => {});
  if (presenceHeartbeat) {
    clearInterval(presenceHeartbeat);
    presenceHeartbeat = null;
  }
}

// ── Global install: unload handling + delegated listeners ────────────────
// Installed once from src/main.tsx, before the app mounts.
let installed = false;

export function installAnalytics() {
  if (installed || typeof window === "undefined") return;
  installed = true;

  // Flush the last page's duration and end the session when the tab is
  // actually closing. 'pagehide' fires more reliably than 'beforeunload'
  // on mobile browsers (including backgrounding), which matters since this
  // is a mobile-first app.
  window.addEventListener("pagehide", () => {
    flushCurrentPageDuration();
    endSession();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      flushCurrentPageDuration();
      flushInteractionQueue();
    }
  });

  installDelegatedTracking();
}

// Delegated, app-wide capture for the two interaction types that are safe
// and meaningful to infer generically, without instrumenting every page:
//   • Form submissions ("Forms submitted" in the spec) — action/module
//     only, never field values.
//   • Radix tab triggers ("Tabs opened") — matched by role="tab", which
//     every Tabs component in this app already renders.
// Anything else opts in explicitly via a `data-track="Label"` attribute,
// which pages can add to specific buttons that matter without this file
// needing to know about them.
function installDelegatedTracking() {
  const moduleFromPath = (path: string) => {
    const seg = path.replace(/^\/admin\/?/, "").split("/")[0];
    return seg ? seg.replace(/-/g, " ") : "home";
  };

  document.addEventListener(
    "submit",
    (event) => {
      const form = event.target as HTMLFormElement;
      if (!(form instanceof HTMLFormElement)) return;
      const label = form.getAttribute("data-track-name") || form.name || "Form";
      trackInteraction(`${label} submitted`, moduleFromPath(window.location.pathname), "submitted");
    },
    true
  );

  document.addEventListener(
    "click",
    (event) => {
      const target = (event.target as HTMLElement)?.closest("[role='tab'], [data-track]");
      if (!target) return;
      if (target.matches("[role='tab']")) {
        const label = target.textContent?.trim().slice(0, 60) || "Tab";
        trackInteraction(`Opened ${label} tab`, moduleFromPath(window.location.pathname), "opened");
      } else {
        const label = target.getAttribute("data-track") || "Action";
        trackInteraction(label, moduleFromPath(window.location.pathname), "clicked");
      }
    },
    true
  );

  // Generic, debounced capture of the app's search inputs. Every search
  // box in this app is a plain <input type="search"> or has a "Search…"
  // placeholder — matched here without needing a shared component.
  const searchTimers = new WeakMap<Element, ReturnType<typeof setTimeout>>();
  document.addEventListener(
    "input",
    (event) => {
      const el = event.target as HTMLInputElement;
      if (!el || el.tagName !== "INPUT") return;
      const isSearchField = el.type === "search" || /search/i.test(el.placeholder || "");
      if (!isSearchField) return;
      const existing = searchTimers.get(el);
      if (existing) clearTimeout(existing);
      const timer = setTimeout(() => {
        trackSearch(el.value, moduleFromPath(window.location.pathname));
      }, 800);
      searchTimers.set(el, timer);
    },
    true
  );
}
