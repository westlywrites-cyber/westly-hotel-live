import type { Env, FirestoreDoc } from "../_shared/firebaseRest";
import { fsGet, fsQuery, fsUpdate, fcmSend } from "../_shared/firebaseRest";
import { requireActiveUser, jsonResponse, HttpError } from "../_shared/admin";

interface SendPushBody {
  forRoles?: string[];
  forUserIds?: string[];
  excludeUserId?: string | null;
  title: string;
  body: string;
  link?: string;
  notificationId?: string;
}

// Firestore 'in' queries top out at 10 values — the role list is small and
// fixed (7 roles), so this is always safe without chunking.
const MAX_IN_CLAUSE = 10;

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const { request, env } = context;
  try {
    await requireActiveUser(env, request.headers.get("authorization"));
    const payload = await request.json<SendPushBody>();

    if (!payload.title || !payload.body) {
      throw new HttpError(400, "title and body are required.");
    }
    const roles = (payload.forRoles ?? []).slice(0, MAX_IN_CLAUSE);
    const userIds = payload.forUserIds ?? [];

    if (roles.length === 0 && userIds.length === 0) {
      return jsonResponse(200, { sent: 0, reason: "no target roles or users" });
    }

    // Gather the target users: everyone matching a target role, plus any
    // explicitly named user ids, minus the actor (if they shouldn't be pinged
    // about their own action) and minus suspended/deleted accounts.
    const userDocs = new Map<string, Record<string, any>>();

    if (roles.length > 0) {
      const matches = await fsQuery(env, "users", [{ field: "role", op: "in", value: roles }]);
      matches.forEach((d) => userDocs.set(d.id, d.data()));
    }
    if (userIds.length > 0) {
      const results = await Promise.all(userIds.map((id) => fsGet(env, "users", id)));
      results.forEach((d: FirestoreDoc) => {
        if (d.exists) userDocs.set(d.id, d.data());
      });
    }
    if (payload.excludeUserId) userDocs.delete(payload.excludeUserId);

    const tokenToOwner = new Map<string, string>();
    userDocs.forEach((data, uid) => {
      if (data.status !== "active" || data.isDeleted) return;
      const userTokens: string[] = Array.isArray(data.fcmTokens) ? data.fcmTokens : [];
      userTokens.forEach((t) => tokenToOwner.set(t, uid));
    });

    if (tokenToOwner.size === 0) {
      return jsonResponse(200, { sent: 0, reason: "no registered devices for target users" });
    }

    const results = await Promise.all(
      [...tokenToOwner.keys()].map((token) =>
        fcmSend(env, {
          token,
          title: payload.title,
          body: payload.body,
          data: { link: payload.link ?? "/admin/dashboard", notificationId: payload.notificationId ?? "" },
          webpushLink: payload.link ?? "/admin/dashboard",
          webpushIcon: "/admin-icons/admin-icon-192.png",
        }).then((r) => ({ token, ...r }))
      )
    );

    const sent = results.filter((r) => r.success).length;
    const failed = results.length - sent;

    // Prune tokens that are no longer valid (uninstalled/expired) so the
    // fcmTokens arrays don't grow unbounded with dead entries over time.
    const invalidByUser = new Map<string, Set<string>>();
    results.forEach((r) => {
      if (!r.success && r.isInvalidToken) {
        const uid = tokenToOwner.get(r.token)!;
        if (!invalidByUser.has(uid)) invalidByUser.set(uid, new Set());
        invalidByUser.get(uid)!.add(r.token);
      }
    });
    if (invalidByUser.size > 0) {
      await Promise.all(
        [...invalidByUser.entries()].map(([uid, invalidSet]) => {
          const data = userDocs.get(uid)!;
          const userTokens: string[] = Array.isArray(data.fcmTokens) ? data.fcmTokens : [];
          const kept = userTokens.filter((t) => !invalidSet.has(t));
          if (kept.length === userTokens.length) return Promise.resolve();
          return fsUpdate(env, "users", uid, { fcmTokens: kept });
        })
      );
    }

    return jsonResponse(200, { sent, failed });
  } catch (err: any) {
    if (err instanceof HttpError) return jsonResponse(err.statusCode, { error: err.message });
    return jsonResponse(500, { error: err?.message || "Failed to send push notification." });
  }
};
