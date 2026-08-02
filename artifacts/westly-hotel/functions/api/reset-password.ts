import type { Env } from "../_shared/firebaseRest";
import { authUpdateUser } from "../_shared/firebaseRest";
import { requireSuperAdmin, jsonResponse, HttpError } from "../_shared/admin";
import { logServerAction } from "../_shared/serverAudit";

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const { request, env } = context;
  try {
    const caller = await requireSuperAdmin(env, request.headers.get("authorization"));
    const { uid, newPassword } = await request.json<{ uid?: string; newPassword?: string }>();

    if (!uid || !newPassword) {
      throw new HttpError(400, "uid and newPassword are required.");
    }
    if (newPassword.length < 8) {
      throw new HttpError(400, "Password must be at least 8 characters.");
    }

    await authUpdateUser(env, uid, { password: newPassword });

    await logServerAction(env, caller.uid, caller.name, "password_reset", "users", uid);

    return jsonResponse(200, { success: true });
  } catch (err: any) {
    if (err instanceof HttpError) return jsonResponse(err.statusCode, { error: err.message });
    return jsonResponse(400, { error: err?.message || "Failed to reset password." });
  }
};

// Cloudflare Pages Functions auto-return 405 Method Not Allowed for any
// verb that doesn't have a matching onRequest<Verb> export on this route,
// so the explicit `if (event.httpMethod !== "POST")` check from the
// Netlify version is no longer needed — this is handled for you.
