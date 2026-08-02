import { type Env, fsAdd, fsGet, fcmSend, serverTimestamp } from "./firebaseRest";

const TELEGRAM_WORKER_URL = "https://westlyhotel.investorwestly.workers.dev/";

interface ServerNotifyParams {
  type: string;
  title: string;
  message: string;
  forUserIds: string[];
  severity?: "info" | "success" | "warning" | "critical";
  link?: string;
}

/**
 * Server-side equivalent of src/lib/notifications.ts's notify(), for use
 * from a background/scheduled Cloudflare Function or Worker (no signed-in
 * client user, so it can't call the send-push route the way the client
 * does — it writes to Firestore/FCM directly instead). Writes the identical
 * `notifications` doc shape so the in-app Notification Center can't tell
 * the difference between a client-triggered and a system-triggered
 * notification.
 */
export async function serverNotify(env: Env, params: ServerNotifyParams): Promise<void> {
  if (params.forUserIds.length === 0) return;

  const { id: notificationId } = await fsAdd(env, "notifications", {
    type: params.type,
    title: params.title,
    message: params.message,
    severity: params.severity ?? "info",
    link: params.link ?? null,
    forRoles: [],
    forUserIds: params.forUserIds,
    excludeUserId: null,
    actorId: "system",
    readBy: [],
    deletedBy: [],
    createdAt: serverTimestamp(),
  });

  // Push, best-effort — never let a push failure stop task generation.
  try {
    const userDocs = await Promise.all(params.forUserIds.map((id) => fsGet(env, "users", id)));
    const tokens: string[] = [];
    userDocs.forEach((snap) => {
      const data = snap.data();
      if (!snap.exists || data.status !== "active" || data.isDeleted) return;
      if (Array.isArray(data.fcmTokens)) tokens.push(...data.fcmTokens);
    });
    await Promise.all(
      tokens.map((token) =>
        fcmSend(env, {
          token,
          title: params.title,
          body: params.message,
          data: { link: params.link ?? "/admin/housekeeping", notificationId },
          webpushLink: params.link ?? "/admin/housekeeping",
          webpushIcon: "/admin-icons/admin-icon-192.png",
        }).catch(() => null)
      )
    );
  } catch {
    /* push failure is non-fatal */
  }

  // Telegram — best-effort, mirrors the client notify() behavior.
  try {
    await fetch(TELEGRAM_WORKER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: `🏨 *${params.title}*\n${params.message}` }),
    });
  } catch {
    /* Telegram failure is non-fatal */
  }
}
