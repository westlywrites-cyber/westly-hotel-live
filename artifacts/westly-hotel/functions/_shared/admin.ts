// ══════════════════════════════════════════════════════════════════════════
// Shared caller-authorization helpers for all Cloudflare Pages Functions in
// this folder. This is the ONLY place service-account credentials are
// touched — never import this from client code.
//
// Business logic (who is allowed to do what) is unchanged from
// netlify/functions/_shared/admin.ts. Only the plumbing changed:
//   - firebase-admin's adminAuth/adminDb  →  functions/_shared/firebaseRest.ts
//   - jsonResponse() returns a Netlify {statusCode,...} object → now a
//     native Response
// ══════════════════════════════════════════════════════════════════════════
import { type Env, fsGet, authVerifyIdToken, type DecodedIdToken } from "./firebaseRest";

export class HttpError extends Error {
  constructor(public statusCode: number, message: string) {
    super(message);
  }
}

export function jsonResponse(statusCode: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: statusCode,
    headers: { "Content-Type": "application/json" },
  });
}

async function verifyCaller(env: Env, authHeader: string | null | undefined): Promise<DecodedIdToken> {
  if (!authHeader?.startsWith("Bearer ")) {
    throw new HttpError(401, "Missing Authorization header.");
  }
  const idToken = authHeader.slice("Bearer ".length);
  try {
    return await authVerifyIdToken(env, idToken);
  } catch {
    throw new HttpError(401, "Invalid or expired session. Please sign in again.");
  }
}

/**
 * Verifies the caller's Firebase ID token (sent as "Authorization: Bearer <token>")
 * and confirms they are an active super_admin according to Firestore. Throws
 * HttpError on any failure — callers should catch and translate to a response.
 */
export async function requireSuperAdmin(env: Env, authHeader: string | null | undefined) {
  const decoded = await verifyCaller(env, authHeader);
  const callerSnap = await fsGet(env, "users", decoded.uid);
  const caller = callerSnap.data();

  if (
    !callerSnap.exists ||
    caller?.role !== "super_admin" ||
    caller?.status !== "active" ||
    caller?.isDeleted
  ) {
    throw new HttpError(403, "Only an active Super Admin can perform this action.");
  }

  return { uid: decoded.uid, name: caller.name as string };
}

/**
 * Verifies the caller's Firebase ID token and confirms they are ANY active,
 * non-deleted admin/staff user (not necessarily super_admin). Used by
 * functions like send-push that are legitimately called by every role —
 * every staff action that triggers a notification needs to be able to ask
 * for that notification to be pushed.
 */
export async function requireActiveUser(env: Env, authHeader: string | null | undefined) {
  const decoded = await verifyCaller(env, authHeader);
  const callerSnap = await fsGet(env, "users", decoded.uid);
  const caller = callerSnap.data();

  if (!callerSnap.exists || caller?.status !== "active" || caller?.isDeleted) {
    throw new HttpError(403, "Only an active staff account can perform this action.");
  }

  return { uid: decoded.uid, name: caller.name as string, role: caller.role as string };
}

/**
 * Verifies the caller is an active super_admin, manager, or
 * operations_manager — the roles allowed to manually trigger the
 * housekeeping queue generator for testing/troubleshooting.
 */
export async function requireHousekeepingSupervisor(env: Env, authHeader: string | null | undefined) {
  const caller = await requireActiveUser(env, authHeader);
  if (!["super_admin", "manager", "operations_manager"].includes(caller.role)) {
    throw new HttpError(403, "Only Super Admin, Manager, or Operations Manager can do this.");
  }
  return caller;
}
