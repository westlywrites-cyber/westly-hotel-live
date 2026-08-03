import type { Env } from "../_shared/firebaseRest";
import { fsGet, fsUpdate } from "../_shared/firebaseRest";
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
    const { uid, newPin } = await request.json<{ uid?: string; newPin?: string }>();

    if (!uid || !newPin) {
      throw new HttpError(400, "uid and newPin are required.");
    }
    if (newPin.length < 4) {
      throw new HttpError(400, "PIN must be at least 4 digits.");
    }

    const snap = await fsGet(env, "users", uid);
    if (!snap.exists) throw new HttpError(404, "User not found.");

    await fsUpdate(env, "users", uid, {
      pinHash: await hashPin(newPin),
      // Clear the legacy field so old-format PINs can't still work after a reset.
      pin: null,
    });

    await logServerAction(env, caller.uid, caller.name, "pin_reset", "users", uid);

    return jsonResponse(200, { success: true });
  } catch (err: any) {
    if (err instanceof HttpError) return jsonResponse(err.statusCode, { error: err.message });
    return jsonResponse(400, { error: err?.message || "Failed to reset PIN." });
  }
};
