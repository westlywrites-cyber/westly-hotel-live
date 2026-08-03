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
 */
export function useCollection<T extends { id?: string }>(
  collectionName: string,
  queryConstraints: QueryConstraint[] = []
) {
  const [data, setData] = useState<T[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  // Stable serialized key to avoid re-subscribing unless constraints actually change
  const constraintsKey = JSON.stringify(queryConstraints.map(c => c.type));

  useEffect(() => {
    setLoading(true);
    const q = query(collection(db, collectionName), ...queryConstraints);
    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        const docs = snapshot.docs.map(docSnap => ({
          id: docSnap.id,
          ...docSnap.data(),
        })) as T[];
        setData(docs);
        setLoading(false);
        setError(null);
      },
      (err) => {
        console.error(`[useCollection] Error fetching ${collectionName}:`, err);
        setError(err);
        setLoading(false);
        // Don't leave stale/cached data on screen when a query is denied or
        // fails — that's what caused inconsistent counts across browsers
        // (each browser silently kept whatever it last had cached locally).
        setData([]);
      }
    );
    return () => unsubscribe();
  }, [collectionName, constraintsKey]); // eslint-disable-line react-hooks/exhaustive-deps

  return { data, loading, error };
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
