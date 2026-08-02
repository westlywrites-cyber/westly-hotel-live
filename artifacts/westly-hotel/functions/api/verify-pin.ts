import type { Env } from "../_shared/firebaseRest";
import { fsQuery, fsSet, authCreateCustomToken } from "../_shared/firebaseRest";
import { jsonResponse, HttpError } from "../_shared/admin";
import { logServerAction } from "../_shared/serverAudit";
import { canUsePinLogin } from "../../src/lib/rbac";

async function hashPin(pin: string): Promise<string> {
  const data = new TextEncoder().encode(pin);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ══════════════════════════════════════════════════════════════════════════
// Shared-device PIN login.
//
// This MUST run server-side. The client cannot look up "which user has this
// PIN" itself — that requires an unfiltered read of the `users` collection,
// which happens before the visitor has any Firebase Auth session at all, and
// Firestore security rules correctly deny that (isSignedIn() is false).
//
// Here, using server-side credentials (which bypass security rules
// entirely, by design, for trusted server code), we look the PIN up
// ourselves and, on success, mint a Firebase custom token. The client then
// exchanges that for a real, rule-visible Auth session via
// signInWithCustomToken — the standard pattern for turning a non-Firebase
// credential (a PIN) into a first-class session.
// ══════════════════════════════════════════════════════════════════════════
export const onRequestPost: PagesFunction<Env> = async (context) => {
  const { request, env } = context;
  try {
    const { pin } = await request.json<{ pin?: string }>();

    if (!pin || typeof pin !== "string" || !/^\d{4,6}$/.test(pin)) {
      throw new HttpError(400, "Enter a valid 4-6 digit PIN.");
    }

    const hashedPin = await hashPin(pin);

    // Current field, then legacy field for backwards compatibility with
    // accounts provisioned before the pinHash rename.
    let doc = (await fsQuery(env, "users", [{ field: "pinHash", op: "==", value: hashedPin }], { limit: 1 }))[0];
    if (!doc) {
      doc = (await fsQuery(env, "users", [{ field: "pin", op: "==", value: hashedPin }], { limit: 1 }))[0];
    }

    // Same generic message for "no match" and every other rejection reason
    // below where it's safe to stay vague — don't help someone brute-force
    // PINs by revealing which ones exist.
    if (!doc || doc.data().isDeleted) {
      throw new HttpError(401, "Invalid PIN.");
    }

    const data = doc.data();

    if (data.status !== "active") {
      throw new HttpError(403, "This account is not active. Contact your administrator.");
    }
    if (!canUsePinLogin(data.role)) {
      throw new HttpError(403, "This role must sign in with email and password.");
    }

    // Custom claim `pinSession: true` rides along on the resulting ID token
    // and is how AuthContext (and, if ever needed, security rules via
    // request.auth.token.pinSession) distinguish a shared-device session
    // from a full email/password login — e.g. for the 15-minute inactivity
    // auto-logout that only applies to PIN terminals.
    const customToken = await authCreateCustomToken(env, doc.id, {
      role: data.role,
      pinSession: true,
    });

    fsSet(env, "users", doc.id, { lastLogin: new Date() }, { merge: true }).catch(() => {});
    logServerAction(env, doc.id, data.name, "pin_login", "users", doc.id, null, null, data.role).catch(() => {});

    return jsonResponse(200, {
      customToken,
      user: {
        id: doc.id,
        name: data.name,
        email: data.email,
        phone: data.phone ?? null,
        role: data.role,
        status: data.status,
        profileImage: data.profileImage ?? null,
      },
    });
  } catch (err: any) {
    if (err instanceof HttpError) return jsonResponse(err.statusCode, { error: err.message });
    console.error("[verify-pin] Unexpected error:", err);
    return jsonResponse(500, { error: "Something went wrong. Please try again." });
  }
};
