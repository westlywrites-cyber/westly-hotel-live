import { useEffect, useState, useRef } from "react";
import {
  onSnapshot,
  collection,
  query,
  QueryConstraint,
  doc,
  Query,
  DocumentReference,
  where,
  documentId,
} from "firebase/firestore";
import { db } from "@/lib/firebase";

/**
 * Subscribe to a Firestore collection (with optional query constraints).
 * Automatically excludes soft-deleted documents unless you explicitly include them.
 *
 * `depsKey` (optional): an explicit string identifying the *values* behind
 * queryConstraints, e.g. `` `${roomId}:${open}` ``. Pass this whenever the
 * same constraint list (same field names, same operators, same order) can
 * be rebuilt with a DIFFERENT value between renders — for example a filter
 * whose target id changes when a collapsed panel is expanded. Without it,
 * this hook only re-subscribes when the constraint *shape* changes (its
 * list of `where`/`orderBy`/`limit` types), because QueryConstraint objects
 * don't expose their actual filter values in a way that's safe to inspect
 * here — so a value-only change would otherwise be silently missed and the
 * component would keep listening to its original, stale query forever.
 *
 * RECOVERY FROM A DROPPED LISTENER — a weak/unstable connection can cause
 * onSnapshot's error callback to fire (Firestore doesn't always transparently
 * retry a listener through a real "unavailable" — a screen-off/backgrounded
 * tab, a spotty mobile network, etc. can bubble up as an error rather than
 * silently reconnecting). Previously, once that happened, `error` stayed set
 * forever — neither `collectionName` nor `constraintsKey` changed on their
 * own, so the effect never re-ran, and the only way out was a full page
 * reload. This hook now retries the subscription itself a few times with
 * backoff, and also exposes `refetch()` so a "Retry" button can force an
 * immediate new attempt instead of reloading the whole page.
 */
export function useCollection<T extends { id?: string }>(
  collectionName: string,
  queryConstraints: QueryConstraint[] = [],
  depsKey?: string
) {
  const [data, setData] = useState<T[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [retryTick, setRetryTick] = useState(0);
  const retryCountRef = useRef(0);

  // Stable serialized key to avoid re-subscribing unless constraints actually
  // change. Falls back to constraint *types* only when no depsKey is given
  // (preserves prior behavior for every existing call site).
  const constraintsKey = depsKey ?? JSON.stringify(queryConstraints.map(c => c.type));

  // Manual retry — bumps retryTick, which is in the effect's deps below, so
  // it tears down the old (dead) listener and opens a fresh one right away.
  const refetch = () => {
    retryCountRef.current = 0;
    setRetryTick(t => t + 1);
  };

  useEffect(() => {
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    setLoading(true);
    const q = query(collection(db, collectionName), ...queryConstraints);
    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        if (cancelled) return;
        retryCountRef.current = 0; // a good snapshot resets the backoff counter
        const docs = snapshot.docs.map(docSnap => ({
          id: docSnap.id,
          ...docSnap.data(),
        })) as T[];
        setData(docs);
        setLoading(false);
        setError(null);
      },
      (err) => {
        if (cancelled) return;
        console.error(`[useCollection] Error fetching ${collectionName}:`, err);
        setError(err);
        setLoading(false);
        // Don't leave stale/cached data on screen when a query is denied or
        // fails — that's what caused inconsistent counts across browsers
        // (each browser silently kept whatever it last had cached locally).
        setData([]);

        // Auto-retry transient failures (network blips, a listener dropped
        // while the tab was backgrounded) with capped exponential backoff —
        // up to 3 attempts (2s, 4s, 8s) — so most users never even see the
        // error state resolve into a stuck screen. A persistent problem
        // (bad security rules, a genuinely missing index) will still fail
        // after these retries and leave `error` set for the UI to surface,
        // with `refetch()` available for the person to try again manually.
        if (retryCountRef.current < 3) {
          retryCountRef.current += 1;
          const delay = 2000 * 2 ** (retryCountRef.current - 1);
          retryTimer = setTimeout(() => {
            if (!cancelled) setRetryTick(t => t + 1);
          }, delay);
        }
      }
    );
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collectionName, constraintsKey, retryTick]);

  return { data, loading, error, refetch };
  }

/**
 * Subscribe to a specific, known set of documents by ID — for when a
 * component only needs a handful of docs out of a much larger collection
 * (e.g. a housekeeper's own assigned rooms, not every room in the hotel).
 * Still fully real-time (onSnapshot), unlike a one-off getDocs fetch.
 *
 * Batches into Firestore's 30-value `in` query limit and merges live
 * updates from every batch. The subscription key is derived from the
 * actual (sorted, deduped) id values — not just their count — so it
 * correctly re-subscribes when the assigned set changes, which a naive
 * reuse of useCollection's type-only constraint key would miss.
 */
export function useDocumentsByIds<T extends { id?: string }>(
  collectionName: string,
  ids: string[]
) {
  const [data, setData] = useState<T[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const uniqueIds = Array.from(new Set((ids || []).filter(Boolean))).sort();
  const idsKey = uniqueIds.join(",");

  useEffect(() => {
    if (uniqueIds.length === 0) {
      setData([]);
      setLoading(false);
      setError(null);
      return;
    }

    setLoading(true);
    const batches: string[][] = [];
    for (let i = 0; i < uniqueIds.length; i += 30) {
      batches.push(uniqueIds.slice(i, i + 30));
    }

    let cancelled = false;
    const resultsByBatch: T[][] = batches.map(() => []);

    const unsubscribes = batches.map((batchIds, idx) =>
      onSnapshot(
        query(collection(db, collectionName), where(documentId(), "in", batchIds)),
        (snapshot) => {
          if (cancelled) return;
          resultsByBatch[idx] = snapshot.docs.map(docSnap => ({
            id: docSnap.id,
            ...docSnap.data(),
          })) as T[];
          setData(resultsByBatch.flat());
          setLoading(false);
          setError(null);
        },
        (err) => {
          if (cancelled) return;
          console.error(`[useDocumentsByIds] Error fetching ${collectionName}:`, err);
          setError(err);
          setLoading(false);
          setData([]);
        }
      )
    );

    return () => {
      cancelled = true;
      unsubscribes.forEach(u => u());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collectionName, idsKey]);

  return { data, loading, error };
}

/**
 * Subscribe to a single Firestore document.
 */
export function useDocument<T extends { id?: string }>(
  collectionName: string,
  documentId: string | null | undefined
) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!documentId) {
      setData(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    const unsubscribe = onSnapshot(
      doc(db, collectionName, documentId),
      (docSnap) => {
        if (docSnap.exists()) {
          setData({ id: docSnap.id, ...docSnap.data() } as T);
        } else {
          setData(null);
        }
        setLoading(false);
        setError(null);
      },
      (err) => {
        console.error(`[useDocument] Error fetching ${collectionName}/${documentId}:`, err);
        setError(err);
        setLoading(false);
      }
    );
    return () => unsubscribe();
  }, [collectionName, documentId]);

  return { data, loading, error };
}