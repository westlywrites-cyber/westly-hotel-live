import { useEffect, useMemo, useState, useCallback } from "react";
import { collection, query, where, orderBy, limit, onSnapshot } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { useAuth } from "@/contexts/AuthContext";
import { markNotificationRead, deleteNotificationForUser } from "@/lib/notifications";
import type { NotificationSeverity, NotificationType } from "@/lib/notifications";

export interface AppNotification {
  id: string;
  type: NotificationType;
  title: string;
  message: string;
  severity: NotificationSeverity;
  link: string | null;
  forRoles: string[];
  forUserIds?: string[];
  excludeUserId?: string | null;
  actorId?: string | null;
  readBy: string[];
  deletedBy: string[];
  createdAt: { toDate: () => Date } | null;
}

const PAGE_SIZE = 60;

/**
 * Realtime notification feed for the signed-in user, scoped to their role.
 * Super Admins implicitly see everything (their role is always included in
 * every notify() call's target list check below), everyone else only sees
 * notifications addressed to their role OR directly to their user id.
 *
 * TWO LIVE QUERIES, MERGED — a single Firestore query can't OR across two
 * different array fields (`forRoles` vs `forUserIds`), so this subscribes to
 * both and merges by doc id. This matters because a large share of
 * notifications in this app are targeted ONLY via forUserIds with an empty
 * forRoles ([]) — shift assigned/updated/cancelled, room assigned/
 * reassigned/ended, housekeeping task queued (incl. the automatic
 * pre-checkout reminder), and task assigned/reassigned all do this (see
 * src/lib/notifications.ts). A single query filtering on
 * `where("forRoles", "array-contains", role)` never matches those docs at
 * all — Firestore's array-contains never matches an empty array — so every
 * one of those notifications was silently invisible to its recipient. The
 * client-side `forUserIds` filter further down in this file was dead code
 * for non-super_admin users as a result: it never got a chance to run
 * because the query itself excluded the docs before they reached it.
 */
export function useNotifications() {
  const { adminUser, role } = useAuth();
  const [byRole, setByRole] = useState<AppNotification[]>([]);
  const [byUser, setByUser] = useState<AppNotification[]>([]);
  const [loadingRole, setLoadingRole] = useState(true);
  const [loadingUser, setLoadingUser] = useState(true);

  useEffect(() => {
    if (!adminUser || !role) {
      setByRole([]);
      setLoadingRole(false);
      return;
    }
    // super_admin always sees everything; everyone else is filtered by role membership.
    const q =
      role === "super_admin"
        ? query(collection(db, "notifications"), orderBy("createdAt", "desc"), limit(PAGE_SIZE))
        : query(
            collection(db, "notifications"),
            where("forRoles", "array-contains", role),
            orderBy("createdAt", "desc"),
            limit(PAGE_SIZE)
          );

    const unsub = onSnapshot(
      q,
      (snap) => {
        setByRole(snap.docs.map((d) => ({ id: d.id, ...d.data() }) as AppNotification));
        setLoadingRole(false);
      },
      () => setLoadingRole(false)
    );
    return unsub;
  }, [adminUser?.id, role]);

  useEffect(() => {
    // super_admin's role-scoped query above already returns every
    // notification, so a second forUserIds subscription would be redundant.
    if (!adminUser || !role || role === "super_admin") {
      setByUser([]);
      setLoadingUser(false);
      return;
    }
    const q = query(
      collection(db, "notifications"),
      where("forUserIds", "array-contains", adminUser.id),
      orderBy("createdAt", "desc"),
      limit(PAGE_SIZE)
    );
    const unsub = onSnapshot(
      q,
      (snap) => {
        setByUser(snap.docs.map((d) => ({ id: d.id, ...d.data() }) as AppNotification));
        setLoadingUser(false);
      },
      () => setLoadingUser(false)
    );
    return unsub;
  }, [adminUser?.id, role]);

  const loading = loadingRole || loadingUser;
  const all = useMemo(() => {
    const merged = new Map<string, AppNotification>();
    for (const n of byRole) merged.set(n.id, n);
    for (const n of byUser) merged.set(n.id, n);
    return Array.from(merged.values()).sort((a, b) => {
      const at = a.createdAt?.toDate?.().getTime() ?? 0;
      const bt = b.createdAt?.toDate?.().getTime() ?? 0;
      return bt - at;
    });
  }, [byRole, byUser]);

  const notifications = useMemo(() => {
    if (!adminUser) return [];
    return all
      .filter((n) => !(n.deletedBy ?? []).includes(adminUser.id))
      .filter((n) => n.excludeUserId !== adminUser.id)
      .filter((n) => {
        // If a notification names specific recipients, only they (plus super_admin) see it.
        if (n.forUserIds && n.forUserIds.length > 0) {
          return n.forUserIds.includes(adminUser.id) || adminUser.role === "super_admin";
        }
        return true;
      });
  }, [all, adminUser]);

  const unreadCount = useMemo(() => {
    if (!adminUser) return 0;
    return notifications.filter((n) => !(n.readBy ?? []).includes(adminUser.id)).length;
  }, [notifications, adminUser]);

  const markAsRead = useCallback(
    (id: string) => (adminUser ? markNotificationRead(id, adminUser.id) : Promise.resolve()),
    [adminUser?.id]
  );

  const markAllAsRead = useCallback(async () => {
    if (!adminUser) return;
    const unread = notifications.filter((n) => !(n.readBy ?? []).includes(adminUser.id));
    await Promise.all(unread.map((n) => markNotificationRead(n.id, adminUser.id)));
  }, [adminUser?.id, notifications]);

  const remove = useCallback(
    (id: string) => (adminUser ? deleteNotificationForUser(id, adminUser.id) : Promise.resolve()),
    [adminUser?.id]
  );

  return { notifications, unreadCount, loading, markAsRead, markAllAsRead, remove };
}