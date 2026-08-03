import type { Env } from "../_shared/firebaseRest";
import { authUpdateUser, fsGet, fsUpdate, serverTimestamp } from "../_shared/firebaseRest";
import { requireSuperAdmin, jsonResponse, HttpError } from "../_shared/admin";
import { logServerAction } from "../_shared/serverAudit";

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const { request, env } = context;
  try {
    const caller = await requireSuperAdmin(env, request.headers.get("authorization"));
    const { uid, status } = await request.json<{ uid?: string; status?: string }>();

    if (!uid || (status !== "active" && status !== "suspended")) {
      throw new HttpError(400, "uid and status ('active' | 'suspended') are required.");
    }

    // Disable the real Firebase Auth account when suspending — previously
    // only a Firestore field changed, so a suspended user's password (or an
    // existing session) still worked for anything not gated by Firestore rules.
    await authUpdateUser(env, uid, { disabled: status === "suspended" });

    const prevSnap = await fsGet(env, "users", uid);
    await fsUpdate(env, "users", uid, { status, updatedAt: serverTimestamp() });

    await logServerAction(
      env,
      caller.uid,
      caller.name,
      `user_${status}`,
      "users",
      uid,
      { status: prevSnap.data()?.status },
      { status }
    );

    return jsonResponse(200, { success: true });
  } catch (err: any) {
    if (err instanceof HttpError) return jsonResponse(err.statusCode, { error: err.message });
    return jsonResponse(400, { error: err?.message || "Failed to update user status." });
  }
};
