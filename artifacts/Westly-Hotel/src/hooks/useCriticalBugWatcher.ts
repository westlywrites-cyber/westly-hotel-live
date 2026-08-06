import { useEffect, useRef } from "react";
import { onSnapshot, collection, query, where, orderBy, limit } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { notifyCriticalBug } from "@/lib/notifications";
import { deriveModule } from "@/lib/bugTracker";

// ══════════════════════════════════════════════════════════════════════════
// Mounted once for Super Admin sessions (see AdminShell.tsx). Watches the
// automatic bug_events capture stream for new critical-severity events and
// immediately raises the "Immediately notify the Super Admin" requirement
// from the Bug Management Center spec, without waiting for anyone to open
// that page. No Cloud Functions / server triggers exist in this project's
// infrastructure (Netlify Functions only), so the notification fires from
// whichever Super Admin session currently has the admin app open — the
// same real-time model already used everywhere else in this app.
// ══════════════════════════════════════════════════════════════════════════
export function useCriticalBugWatcher(enabled: boolean) {
  const mountedAtRef = useRef<number>(Date.now());
  const notifiedFingerprintsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!enabled) return;
    mountedAtRef.current = Date.now();

    const q = query(
      collection(db, "bug_events"),
      where("severity", "==", "critical"),
      orderBy("timestamp", "desc"),
      limit(20)
    );

    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        for (const change of snapshot.docChanges()) {
          if (change.type !== "added") continue;
          const data = change.doc.data() as any;
          const ts = data.timestamp?.toDate ? data.timestamp.toDate().getTime() : 0;
          // Only notify for events that arrived after this session mounted —
          // avoids re-notifying about pre-existing critical bugs on every login.
          if (ts < mountedAtRef.current) continue;

          const fingerprint = data.fingerprint || change.doc.id;
          if (notifiedFingerprintsRef.current.has(fingerprint)) continue;
          notifiedFingerprintsRef.current.add(fingerprint);

          notifyCriticalBug(
            data.title || data.message || "Critical bug",
            data.module || deriveModule(data.page, data.category),
            1
          ).catch(() => { /* non-fatal — the bug event itself is already saved */ });
        }
      },
      () => { /* listener errors are silently ignored — this is a best-effort watcher */ }
    );

    return () => unsubscribe();
  }, [enabled]);
}
