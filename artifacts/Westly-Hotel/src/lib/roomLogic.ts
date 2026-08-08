import { collection, query, where, getDocs, doc, updateDoc } from "firebase/firestore";
import { db, rtdb } from "./firebase";
import { ref, set } from "firebase/database";

export type RoomStatus = "available" | "occupied" | "reserved" | "cleaning" | "maintenance" | "out_of_service";

// The query every conflict check reads — centralized so detectConflict(),
// detectConflictInTransaction(), and any future call site always agree on
// which booking_dates rows count as "active" for availability purposes.
function conflictQuery(roomId: string) {
  return query(
    collection(db, "booking_dates"),
    where("roomId", "==", roomId),
    where("status", "in", ["confirmed", "checked_in", "pending"])
  );
}

/**
 * Standard overlap formula, shared by every conflict-check call site so it
 * is only ever expressed once: existing.checkIn < new.checkOut AND
 * existing.checkOut > new.checkIn. Same-day turnover (one booking's
 * check-out exactly equals another's check-in) is NOT a conflict.
 */
export function datesOverlap(aCheckIn: Date, aCheckOut: Date, bCheckIn: Date, bCheckOut: Date): boolean {
  return aCheckIn < bCheckOut && aCheckOut > bCheckIn;
}

function toDate(value: any): Date {
  return value?.toDate ? value.toDate() : new Date(value);
}

/**
 * Pure conflict-evaluation core, decoupled from Firestore so it can be unit
 * tested directly. `docs` is any array of objects exposing `.id` and
 * `.data()` — both QuerySnapshot.docs (from getDocs) and the docs returned
 * by transaction.get(query) satisfy this shape.
 */
export function findConflictInDocs(
  docs: { id: string; data: () => any }[],
  checkIn: Date,
  checkOut: Date,
  excludeBookingId?: string
): boolean {
  for (const docSnap of docs) {
    if (excludeBookingId && docSnap.id === excludeBookingId) continue;
    const booking = docSnap.data();
    const bCheckIn = toDate(booking.checkIn);
    const bCheckOut = toDate(booking.checkOut);
    if (datesOverlap(bCheckIn, bCheckOut, checkIn, checkOut)) return true;
  }
  return false;
}

/**
 * Detect booking conflicts for a room in a given date range.
 * Returns true if there is an overlapping active booking.
 *
 * NON-TRANSACTIONAL — this is a plain read and does not guard against a
 * concurrent write racing in between this check and a later write. It
 * remains useful as a UX-only early warning (e.g. during date selection,
 * before the final submit). The actual atomicity guarantee for a real
 * booking write must come from detectConflictInTransaction() below, used
 * inside a runTransaction() block.
 */
export async function detectConflict(
  roomId: string,
  checkIn: Date,
  checkOut: Date,
  excludeBookingId?: string
): Promise<boolean> {
  // Reads from booking_dates, not bookings: bookings holds guest PII and is
  // restricted to signed-in staff, but this needs to run for anonymous
  // visitors on the public booking page too. booking_dates is a PII-free
  // mirror (roomId + date range + status) kept in sync wherever a booking
  // is created or its status changes — see firestore.rules for details.
  const snapshot = await getDocs(conflictQuery(roomId));
  return findConflictInDocs(snapshot.docs, checkIn, checkOut, excludeBookingId);
}


/**
 * Find rooms of a given type that have NO conflicts for the requested dates.
 */
export async function findAvailableRooms(
  roomType: string,
  checkIn: Date,
  checkOut: Date
): Promise<any[]> {
  // Only filter by isDeleted server-side (single-field, so no composite
  // index needed) and filter by room type client-side — combining both in
  // one query would require a composite index that doesn't exist in
  // firestore.indexes.json (same root cause as the Check-Out/Walk-In bugs).
  const roomsSnap = await getDocs(
    query(collection(db, "rooms"), where("isDeleted", "!=", true))
  );

  const available: any[] = [];

  for (const roomDoc of roomsSnap.docs) {
    const room = { id: roomDoc.id, ...roomDoc.data() } as any;
    if (room.type !== roomType) continue;
    const hasConflict = await detectConflict(room.id, checkIn, checkOut);
    if (!hasConflict) {
      available.push(room);
    }
  }

  return available;
}

/**
 * Update room status in BOTH Firestore (authoritative) and Realtime Database (live sync).
 * This must be called whenever room status changes to keep both databases consistent.
 */
export async function updateRoomStatus(
  roomId: string,
  newStatus: RoomStatus,
  extra?: Record<string, unknown>
): Promise<void> {
  // 1. Firestore is the source of truth — update it first
  await updateDoc(doc(db, "rooms", roomId), {
    status: newStatus,
    statusUpdatedAt: new Date(),
    ...extra,
  });

  // 2. Realtime DB for live dashboard feeds
  const statusRef = ref(rtdb, `roomStatus/${roomId}`);
  await set(statusRef, {
    status: newStatus,
    updatedAt: Date.now(),
    ...extra,
  });
}

/**
 * Trigger a room status transition based on an event.
 * Derived status map per spec Section 7.
 */
export async function triggerRoomStatus(
  roomId: string,
  event: "check_in" | "check_out" | "start_cleaning" | "finish_cleaning" | "maintenance" | "back_to_service"
): Promise<void> {
  const statusMap: Record<string, RoomStatus> = {
    check_in: "occupied",
    check_out: "cleaning",       // On checkout → always goes to Cleaning first
    start_cleaning: "cleaning",
    finish_cleaning: "available",
    maintenance: "maintenance",
    back_to_service: "available",
  };

  const newStatus = statusMap[event];
  if (!newStatus) throw new Error(`Unknown room event: ${event}`);

  await updateRoomStatus(roomId, newStatus);
}
