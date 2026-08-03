import {
  collection, doc, addDoc, updateDoc, getDoc, query, where, getDocs,
  serverTimestamp, Timestamp,
} from "firebase/firestore";
import { db } from "./firebase";
import { logAction } from "./audit";
import {
  notifyGymMembershipRegistered, notifyGymMembershipRenewed,
  notifyGymMembershipSuspended, notifyGymCheckIn, notifyGymCheckOut,
} from "./notifications";

// ══════════════════════════════════════════════════════════════════════════
// GYM MEMBERSHIP MANAGEMENT
//
// Collections:
//   gym_members     — one doc per member (guest or public member). Status is
//                      stored but also derived live from endDate (see
//                      effectiveMemberStatus) so an expired membership shows
//                      correctly even if nobody has touched the record.
//   gym_attendance  — one doc per visit (check-in, optionally checked out).
//                      dateKey ("yyyy-MM-dd") lets the daily visitor log and
//                      attendance history filter/group client-side without
//                      needing a composite Firestore index, matching the
//                      pattern used by src/pages/admin/AttendancePage.tsx.
// ══════════════════════════════════════════════════════════════════════════

export type GymMembershipStatus = "active" | "expired" | "suspended" | "cancelled";

export const GYM_MEMBERSHIP_STATUSES: GymMembershipStatus[] = ["active", "expired", "suspended", "cancelled"];

export const GYM_STATUS_COLORS: Record<GymMembershipStatus, string> = {
  active: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400",
  expired: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
  suspended: "bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-400",
  cancelled: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400",
};

interface Actor {
  id: string;
  name: string;
  role?: string | null;
}

function toDate(value: any): Date | null {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (value?.toDate) return value.toDate();
  return new Date(value);
}

function dateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * The membership status that should actually be shown for a member right
 * now: an 'active' record whose endDate has passed reads as 'expired' even
 * before anyone edits the record. 'suspended' and 'cancelled' are explicit
 * staff actions and always take precedence over the date.
 */
export function effectiveMemberStatus(member: { status: GymMembershipStatus; endDate?: any }): GymMembershipStatus {
  if (member.status === "suspended" || member.status === "cancelled") return member.status;
  const end = toDate(member.endDate);
  if (end && end.getTime() < Date.now()) return "expired";
  return member.status === "expired" ? "active" : member.status;
}

/** Days remaining until a membership's endDate (negative if already past). */
export function daysUntilExpiry(endDate: any): number | null {
  const end = toDate(endDate);
  if (!end) return null;
  return Math.ceil((end.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
}

// ── Membership registration & renewal ───────────────────────────────────

export interface RegisterMemberParams {
  name: string;
  email?: string | null;
  phone?: string | null;
  roomNumber?: string | null; // set when the member is a current hotel guest
  packageId: string;
  packageName: string;
  packagePrice: number;
  durationDays: number;
  notes?: string | null;
  actor: Actor;
}

export async function registerGymMember(params: RegisterMemberParams): Promise<string> {
  const { name, email, phone, roomNumber, packageId, packageName, packagePrice, durationDays, notes, actor } = params;
  if (!name.trim()) throw new Error("Member name is required.");

  const startDate = new Date();
  const endDate = new Date(startDate.getTime() + durationDays * 24 * 60 * 60 * 1000);

  const ref = await addDoc(collection(db, "gym_members"), {
    name: name.trim(),
    email: email || null,
    phone: phone || null,
    roomNumber: roomNumber || null,
    packageId,
    packageName,
    packagePrice,
    durationDays,
    startDate: Timestamp.fromDate(startDate),
    endDate: Timestamp.fromDate(endDate),
    status: "active" as GymMembershipStatus,
    notes: notes || null,
    visitCount: 0,
    lastVisitAt: null,
    registeredBy: actor.id,
    registeredByName: actor.name,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    isDeleted: false,
  });

  await logAction(actor.id, actor.name, "gym_member_registered", "gym_members", ref.id, null, { name, packageId }, actor.role || undefined);
  notifyGymMembershipRegistered(name, packageName, actor.name).catch(() => {});
  return ref.id;
}

export interface RenewMembershipParams {
  memberId: string;
  packageId: string;
  packageName: string;
  packagePrice: number;
  durationDays: number;
  actor: Actor;
}

/**
 * Renews a membership. Extends from the LATER of "now" or the current
 * endDate — a member who renews before expiring keeps their remaining days
 * instead of losing them, while a lapsed member's new period starts today.
 */
export async function renewGymMembership(params: RenewMembershipParams): Promise<void> {
  const { memberId, packageId, packageName, packagePrice, durationDays, actor } = params;
  const snap = await getDoc(doc(db, "gym_members", memberId));
  if (!snap.exists()) throw new Error("Member not found.");
  const data = snap.data() as any;

  const now = new Date();
  const currentEnd = toDate(data.endDate);
  const base = currentEnd && currentEnd.getTime() > now.getTime() ? currentEnd : now;
  const newEnd = new Date(base.getTime() + durationDays * 24 * 60 * 60 * 1000);

  await updateDoc(snap.ref, {
    packageId,
    packageName,
    packagePrice,
    durationDays,
    endDate: Timestamp.fromDate(newEnd),
    status: "active",
    updatedAt: serverTimestamp(),
  });

  await logAction(actor.id, actor.name, "gym_membership_renewed", "gym_members", memberId, { endDate: data.endDate }, { endDate: newEnd }, actor.role || undefined);
  notifyGymMembershipRenewed(data.name, packageName, actor.name).catch(() => {});
}

export async function updateGymMemberDetails(
  memberId: string,
  updates: { name?: string; email?: string | null; phone?: string | null; roomNumber?: string | null; notes?: string | null },
  actor: Actor
): Promise<void> {
  await updateDoc(doc(db, "gym_members", memberId), { ...updates, updatedAt: serverTimestamp() });
  await logAction(actor.id, actor.name, "gym_member_updated", "gym_members", memberId, null, updates, actor.role || undefined);
}

export async function setGymMembershipStatus(
  memberId: string,
  status: GymMembershipStatus,
  actor: Actor,
  reason?: string | null
): Promise<void> {
  const snap = await getDoc(doc(db, "gym_members", memberId));
  if (!snap.exists()) throw new Error("Member not found.");
  const data = snap.data() as any;

  await updateDoc(snap.ref, {
    status,
    statusReason: reason || null,
    updatedAt: serverTimestamp(),
  });

  await logAction(actor.id, actor.name, "gym_membership_status_changed", "gym_members", memberId, { status: data.status }, { status }, actor.role || undefined);
  if (status === "suspended") {
    notifyGymMembershipSuspended(data.name, actor.name, reason).catch(() => {});
  }
}

export async function softDeleteGymMember(memberId: string, actor: Actor): Promise<void> {
  await updateDoc(doc(db, "gym_members", memberId), { isDeleted: true, updatedAt: serverTimestamp() });
  await logAction(actor.id, actor.name, "gym_member_deleted", "gym_members", memberId, null, null, actor.role || undefined);
}

// ── Check-in / check-out ────────────────────────────────────────────────

/** Returns the open (checked-in, not yet checked-out) visit for a member, if any. */
export async function getActiveGymVisit(memberId: string): Promise<{ id: string } & Record<string, any> | null> {
  const snap = await getDocs(query(
    collection(db, "gym_attendance"),
    where("memberId", "==", memberId),
    where("checkOutAt", "==", null),
  ));
  const open = snap.docs.find(d => !d.data().isDeleted);
  return open ? { id: open.id, ...open.data() } : null;
}

export async function checkInGymMember(memberId: string, memberName: string, actor: Actor): Promise<string> {
  const memberSnap = await getDoc(doc(db, "gym_members", memberId));
  if (!memberSnap.exists()) throw new Error("Member not found.");
  const member = memberSnap.data() as any;

  const status = effectiveMemberStatus(member);
  if (status !== "active") {
    throw new Error(
      status === "expired" ? "This membership has expired. Renew before checking in."
        : status === "suspended" ? "This membership is suspended."
        : "This membership is cancelled."
    );
  }

  const existing = await getActiveGymVisit(memberId);
  if (existing) throw new Error(`${memberName} is already checked in.`);

  const now = new Date();
  const ref = await addDoc(collection(db, "gym_attendance"), {
    memberId,
    memberName,
    checkInAt: serverTimestamp(),
    checkOutAt: null,
    checkedInBy: actor.id,
    checkedInByName: actor.name,
    checkedOutBy: null,
    checkedOutByName: null,
    dateKey: dateKey(now),
    isDeleted: false,
  });

  await updateDoc(memberSnap.ref, {
    visitCount: (member.visitCount || 0) + 1,
    lastVisitAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  await logAction(actor.id, actor.name, "gym_checked_in", "gym_attendance", ref.id, null, { memberId }, actor.role || undefined);
  notifyGymCheckIn(memberName, actor.name).catch(() => {});
  return ref.id;
}

export async function checkOutGymMember(visitId: string, memberName: string, actor: Actor): Promise<void> {
  await updateDoc(doc(db, "gym_attendance", visitId), {
    checkOutAt: serverTimestamp(),
    checkedOutBy: actor.id,
    checkedOutByName: actor.name,
  });
  await logAction(actor.id, actor.name, "gym_checked_out", "gym_attendance", visitId, null, null, actor.role || undefined);
  notifyGymCheckOut(memberName, actor.name).catch(() => {});
}
