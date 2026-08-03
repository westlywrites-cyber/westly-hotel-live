import { type Env, fsAdd, serverTimestamp } from "./firebaseRest";

/**
 * Server-side equivalent of src/lib/audit.ts's logAction — used inside
 * Cloudflare Pages Functions where the action is trusted (it already passed
 * requireSuperAdmin) rather than merely claimed by the client.
 */
export async function logServerAction(
  env: Env,
  userId: string,
  userName: string,
  action: string,
  collectionName: string,
  documentId: string,
  previousValue: unknown = null,
  newValue: unknown = null,
  userRole = "super_admin"
): Promise<void> {
  try {
    await fsAdd(env, "audit_logs", {
      userId,
      userName,
      userRole,
      action,
      collection: collectionName,
      documentId,
      previousValue: previousValue as any,
      newValue: newValue as any,
      deviceInfo: "server-function",
      timestamp: serverTimestamp(),
      isDeleted: false,
    });
  } catch (error) {
    console.error("[Audit] Failed to write server-side audit log:", error);
  }
}
