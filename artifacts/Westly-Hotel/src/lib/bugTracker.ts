import { addDoc, collection, serverTimestamp } from "firebase/firestore";
import { db } from "./firebase";
import type { DiagnosticLogInput, ErrorCategory, ErrorSeverity } from "./diagnostics";

// ══════════════════════════════════════════════════════════════════════════
// BUG MANAGEMENT CENTER — automatic bug capture engine
//
// This is a SEPARATE module from src/lib/diagnostics.ts, with its own
// Firestore collection, page, and navigation entry (Super Admin only). It
// intentionally reuses diagnostics.ts as its single detection funnel
// instead of re-instrumenting the app a second time: every part of the
// application that already reports into captureError() — render crashes,
// JS errors, console errors, failed API/Firestore/Supabase calls, auth
// failures, failed uploads, routing misses, stuck loading states,
// performance issues, background job failures, and any future category
// added to diagnostics.ts — is automatically also a bug candidate here,
// with zero additional call sites required anywhere else in the app.
//
// COLLECTIONS
//   • bug_events — one immutable document per RAW occurrence, written by
//     recordBugEvent() below (same "create-only, validated shape, anyone
//     may write, only Super Admin may read" pattern as diagnostic_logs, so
//     capture still works from signed-out public-website sessions). This is
//     the automatic detection stream.
//   • bugs — one document per FINGERPRINT (a grouped "bug"), written only
//     by the Super Admin from the Bug Management Center as it aggregates
//     bug_events in real time. This is where status, priority, and manual
//     triage decisions live, fully isolated from the anonymous write path
//     so a public visitor can never influence a bug's status/priority.
//
// GROUPING
//   Client-side, deterministic fingerprint = category + normalized source +
//   normalized message (numbers/ids stripped so e.g. two failed loads of
//   different room ids collapse into one bug). The Bug Management Center
//   groups bug_events by this fingerprint and rolls the count up into the
//   matching `bugs/{fingerprint}` document — this is the "avoid duplicate
//   bug reports while keeping an occurrence count and history" requirement.
// ══════════════════════════════════════════════════════════════════════════

export type BugStatus =
  | "new" | "investigating" | "in_progress" | "fixed" | "verified" | "closed" | "ignored" | "duplicate";

export type BugPriority = "urgent" | "high" | "medium" | "low";

export const BUG_STATUS_LABELS: Record<BugStatus, string> = {
  new: "New",
  investigating: "Under Investigation",
  in_progress: "In Progress",
  fixed: "Fixed",
  verified: "Verified",
  closed: "Closed",
  ignored: "Ignored",
  duplicate: "Duplicate",
};

export const BUG_PRIORITY_LABELS: Record<BugPriority, string> = {
  urgent: "Urgent",
  high: "High",
  medium: "Medium",
  low: "Low",
};

// Statuses that mean "we believe this is done" — used to detect a
// regression (a bug that comes back after being marked fixed/verified/closed).
export const RESOLVED_STATUSES: BugStatus[] = ["fixed", "verified", "closed"];

// ── Severity → default priority (Super Admin can always override) ────────
export function derivePriority(severity: ErrorSeverity): BugPriority {
  switch (severity) {
    case "critical": return "urgent";
    case "error": return "high";
    case "warning": return "medium";
    default: return "low";
  }
}

// ── Category → human module label ─────────────────────────────────────────
const CATEGORY_MODULE: Partial<Record<ErrorCategory, string>> = {
  firebase_auth: "Authentication",
  firestore_permission: "Authorization / Firestore",
  firestore_query: "Firestore",
  realtime_sync: "Real-time Sync",
  supabase: "Supabase",
  image_upload: "File Uploads",
  file_upload: "File Uploads",
  network: "Network",
  routing: "Navigation / Routing",
  performance: "Performance",
  background_job: "Background Jobs",
  api: "API",
};

// Route prefix → module label, so the SAME error category (e.g. a Firestore
// permission error) still gets attributed to the actual feature area.
const ROUTE_MODULE_PATTERNS: [RegExp, string][] = [
  [/^\/admin\/housekeeping/, "Housekeeping"],
  [/^\/admin\/(bar)/, "Bar"],
  [/^\/admin\/(restaurant|new-order|orders)/, "Restaurant"],
  [/^\/admin\/laundry/, "Laundry"],
  [/^\/admin\/gym/, "Gym"],
  [/^\/admin\/venues/, "Venue"],
  [/^\/admin\/(rooms|room-assignments|room-reservations)/, "Room Reservations"],
  [/^\/admin\/(bookings|walk-in|check-out)/, "Booking System"],
  [/^\/admin\/(payments|revenue|expenses|financial-reports)/, "Payments"],
  [/^\/admin\/messages/, "Messages"],
  [/^\/admin\/cms|^\/admin\/gallery|^\/admin\/gym-cms/, "CMS"],
  [/^\/admin\/reports|^\/admin\/staff-performance/, "Reports"],
  [/^\/admin\/(attendance|shift)/, "Staff / Attendance"],
  [/^\/admin\/(users|roles)/, "Users & Roles"],
  [/^\/admin\/maintenance/, "Maintenance"],
  [/^\/admin\/lost-found/, "Lost & Found"],
  [/^\/admin\/(dashboard|my-tasks|approvals)/, "Admin Dashboard"],
  [/^\/admin\/(operations|tasks)/, "Operations Manager"],
  [/^\/admin/, "Admin Dashboard"],
  [/^\/booking/, "Booking System"],
  [/^\/rooms/, "Room Reservations"],
  [/^\/restaurant/, "Restaurant"],
  [/^\/gym/, "Gym"],
  [/^\/venue/, "Venue"],
  [/^\/gallery|^\/about|^\/contact|^\/faq|^\/testimonials|^\/facilities|^\/$/, "Public Website"],
];

export function deriveModule(route?: string | null, category?: ErrorCategory): string {
  if (route) {
    for (const [pattern, label] of ROUTE_MODULE_PATTERNS) {
      if (pattern.test(route)) return label;
    }
  }
  if (category && CATEGORY_MODULE[category]) return CATEGORY_MODULE[category]!;
  return "Public Website";
}

// ── Basic device / OS / browser parsing (no external dependency) ─────────
export function parseUserAgent(userAgent?: string | null) {
  const ua = userAgent || "";
  let browser = "Unknown";
  if (/Edg\//.test(ua)) browser = "Edge";
  else if (/Chrome\//.test(ua) && !/OPR\//.test(ua)) browser = "Chrome";
  else if (/Firefox\//.test(ua)) browser = "Firefox";
  else if (/Safari\//.test(ua) && !/Chrome\//.test(ua)) browser = "Safari";
  else if (/OPR\//.test(ua)) browser = "Opera";

  let os = "Unknown";
  if (/Windows/.test(ua)) os = "Windows";
  else if (/Mac OS X/.test(ua)) os = "macOS";
  else if (/Android/.test(ua)) os = "Android";
  else if (/iPhone|iPad|iPod/.test(ua)) os = "iOS";
  else if (/Linux/.test(ua)) os = "Linux";

  let deviceType = "Desktop";
  if (/Mobi|Android(?!.*Tablet)/.test(ua) && !/iPad/.test(ua)) deviceType = "Mobile";
  else if (/iPad|Tablet/.test(ua)) deviceType = "Tablet";

  return { browser, os, deviceType };
}

// ── Fingerprinting (grouping key) ─────────────────────────────────────────
// Strips digits/uuids/emails so occurrences that differ only by a specific
// record id, timestamp, or user identifier still collapse into one bug.
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<uuid>")
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "<email>")
    .replace(/\b\d+\b/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

// Small, dependency-free string hash (djb2) — good enough for a client-side
// grouping key; collisions would only ever merge two unrelated bugs into
// one card, never lose data, since every raw bug_events document is kept.
function hashString(input: string): string {
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) + hash + input.charCodeAt(i)) >>> 0;
  }
  return hash.toString(36);
}

export function computeFingerprint(category: string, source: string | null | undefined, message: string): string {
  const key = `${category}::${normalize(source || "")}::${normalize(message)}`;
  return `bug_${hashString(key)}`;
}

export function deriveBugTitle(category: ErrorCategory, message: string): string {
  const trimmed = message.trim();
  const short = trimmed.length > 90 ? `${trimmed.slice(0, 87)}...` : trimmed;
  return short || `Unclassified ${category} issue`;
}

// ── App / build version ────────────────────────────────────────────────
// No build pipeline currently stamps a version into the client bundle;
// exposed as an env var so one can be wired in later (e.g. via Netlify
// build environment) without any change to this module.
export function getAppVersion(): string {
  return (import.meta as any).env?.VITE_APP_VERSION || "unreleased";
}

// ── Core automatic capture write path ─────────────────────────────────────
// Called from diagnostics.ts's captureError() for every detected issue —
// this file has no other call sites by design, so the whole application's
// existing error-detection surface (see diagnostics.ts) feeds this
// automatically. NEVER throws and NEVER blocks the caller.
export async function recordBugEvent(
  input: DiagnosticLogInput & {
    severity: ErrorSeverity;
    route?: string | null;
    userId?: string | null;
    userName?: string | null;
    userRole?: string | null;
    browser?: Record<string, unknown> | null;
  }
): Promise<void> {
  try {
    const fingerprint = computeFingerprint(input.category, input.source, input.message);
    const module = deriveModule(input.route, input.category);
    const ua = (input.browser?.userAgent as string | undefined) || undefined;
    const { browser, os, deviceType } = parseUserAgent(ua);

    await addDoc(collection(db, "bug_events"), {
      fingerprint,
      title: deriveBugTitle(input.category, input.message),
      message: (input.message || "Unknown error").slice(0, 2000),
      category: input.category,
      severity: input.severity,
      module,
      page: input.route ?? null,
      component: input.source ?? null,
      functionInvolved: input.action ?? null,
      stack: input.stack ? input.stack.slice(0, 4000) : null,
      rootCause: input.rootCause ?? null,
      suggestion: input.suggestion ?? null,
      metadata: input.metadata ?? null,
      userId: input.userId ?? null,
      userName: input.userName ?? null,
      userRole: input.userRole ?? null,
      browserName: browser,
      os,
      deviceType,
      userAgent: ua ?? null,
      appVersion: getAppVersion(),
      buildVersion: getAppVersion(),
      timestamp: serverTimestamp(),
    });
  } catch (err) {
    // The bug tracker must never throw or recurse into itself/diagnostics.
    console.warn("[BugTracker] Failed to record bug event:", err);
  }
}
