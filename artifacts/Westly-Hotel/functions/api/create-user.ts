import type { Env } from "../_shared/firebaseRest";
import { authCreateUser, fsSet } from "../_shared/firebaseRest";
import { requireSuperAdmin, jsonResponse, HttpError } from "../_shared/admin";
import { logServerAction } from "../_shared/serverAudit";

async function hashPin(pin: string): Promise<string> {
  const data = new TextEncoder().encode(pin);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const { request, env } = context;
  try {
    const caller = await requireSuperAdmin(env, request.headers.get("authorization"));
    const { name, email, password, phone, role, pin } = await request.json<{
      name?: string; email?: string; password?: string; phone?: string; role?: string; pin?: string;
    }>();

    if (!name || !email || !password || !role) {
      throw new HttpError(400, "name, email, password, and role are required.");
    }
    if (password.length < 8) {
      throw new HttpError(400, "Password must be at least 8 characters.");
    }
    if (pin && pin.length < 4) {
      throw new HttpError(400, "PIN must be at least 4 digits.");
    }

    // 1. Create the real Firebase Auth account (server-side — does NOT sign
    //    in the calling browser, unlike the client SDK's createUserWithEmailAndPassword).
    const userRecord = await authCreateUser(env, { email, password, displayName: name });

    // 2. Write the Firestore profile doc, keyed by the Auth uid.
    const pinHash = pin ? await hashPin(pin) : null;
    await fsSet(env, "users", userRecord.uid, {
      name,
      email,
      phone: phone || null,
      role,
      status: "active",
      pinHash,
      isDeleted: false,
      createdAt: new Date(),
      createdBy: caller.uid,
    });

    await logServerAction(
      env,
      caller.uid,
      caller.name,
      "user_created",
      "users",
      userRecord.uid,
      null,
      { name, email, role }
    );

    return jsonResponse(200, { uid: userRecord.uid });
  } catch (err: any) {
    if (err instanceof HttpError) return jsonResponse(err.statusCode, { error: err.message });
    // Auth errors (e.g. email already in use) already have a readable .message
    return jsonResponse(400, { error: err?.message || "Failed to create user." });
  }
};
