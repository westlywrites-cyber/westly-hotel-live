import { auth } from "./firebase";
import { logApiError } from "./diagnostics";

// Exported so other admin-facing modules (e.g. messages.ts, storage.ts) can
// reuse the same signed-request + error-logging choke point instead of
// re-implementing it — see callAdminFunction's own comments for why.
export async function callAdminFunction<T>(name: string, payload: unknown): Promise<T> {
  try {
    const currentUser = auth.currentUser;
    if (!currentUser) throw new Error("You must be signed in to do this.");

    const idToken = await currentUser.getIdToken();

    const res = await fetch(`/api/${name}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${idToken}`,
      },
      body: JSON.stringify(payload),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error || "Something went wrong.");
    return data as T;
  } catch (error) {
    // Logged here (the single choke point for every admin function call)
    // rather than in each exported helper below, then re-thrown unchanged
    // so existing callers' try/catch and toast handling keep working exactly
    // as before.
    logApiError(name, error, "callAdminFunction");
    throw error;
  }
}

export function createUserAccount(input: {
  name: string;
  email: string;
  password: string;
  phone?: string;
  role: string;
  pin?: string;
}) {
  return callAdminFunction<{ uid: string }>("create-user", input);
}

export function resetUserPassword(uid: string, newPassword: string) {
  return callAdminFunction<{ success: true }>("reset-password", { uid, newPassword });
}

export function resetUserPin(uid: string, newPin: string) {
  return callAdminFunction<{ success: true }>("reset-pin", { uid, newPin });
}

export function setUserStatus(uid: string, status: "active" | "suspended") {
  return callAdminFunction<{ success: true }>("set-user-status", { uid, status });
}
