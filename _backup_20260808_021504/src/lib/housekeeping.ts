import {
  collection, doc, addDoc, updateDoc, deleteDoc, getDoc, getDocs, query, where,
  writeBatch, serverTimestamp, Timestamp,
} from "firebase/firestore";
import { db } from "./firebase";
import { logAction } from "./audit";
import { updateRoomStatus } from "./roomLogic";
import {
  notifyRoomsAssigned, notifyRoomsReassigned, notifyRoomAssignmentEnded,
  notifyHousekeepingTaskQueued, notifyHousekeepingDone,
} from "./notifications";
import { dateKeyInTimezone } from "./housekeepingSchedule";
import { computeTaskWeight } from "./housekeepingBalance";

export type HousekeepingTaskType = "checkout_cleaning" | "occupied_service" | "manual" | "maintenance_followup" | "cleaning";
export type HousekeepingTaskStatus = "pending" | "in_progress" | "completed" | "skipped";
export type HousekeepingTaskPriority = "low" | "medium" | "high" | "urgent";

export const HOUSEKEEPING_TASK_PRIORITIES: HousekeepingTaskPriority[] = ["low", "medium", "high", "urgent"];

export const HOUSEKEEPING_TASK_TYPE_LABELS: Record<HousekeepingTaskType, string> = {
  checkout_cleaning: "Check-out Cleaning",
  occupied_service: "Occupied Room Service",
  manual: "Manual / Ad-hoc",
  maintenance_followup: "Maintenance Follow-up",
  cleaning: "Cleaning",
};

export const HOUSEKEEPING_PRIORITY_COLORS: Record<HousekeepingTaskPriority, string> = {
  low: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
  medium: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400",
  high: "bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-400",
  urgent: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400",
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

// ══════════════════════════════════════════════════════════════════════════
// LONG-TERM ROOM ASSIGNMENTS (Requirement 2)
// ══════════════════════════════════════════════════════════════════════════

export interface AssignRoomsParams {
  housekeeperId: string;
  housekeeperName: string;
  rooms: { id: string; number: string }[];
  startDate: Date;
  endDate: Date | null; // null = indefinite / ongoing
  notes?: string | null;
  actor: Actor;
}

/**
 * Assigns one or more rooms to a housekeeper for a date range. Handles
 * reassignment transparently: any room that was actively assigned to a
 * DIFFERENT housekeeper is removed from that person's group first (so a
 * room is never owned by two housekeepers at once), and that person is
 * notified. This single function is what both "Assign Rooms" and
 * "Reassign Rooms" call in the UI — the only difference is which rooms/
 * housekeeper the caller passes in.
 */
export async function assignRoomsToHousekeeper(params: AssignRoomsParams): Promise<string> {
  const { housekeeperId, housekeeperName, rooms, startDate, endDate, notes, actor } = params;
  if (rooms.length === 0) throw new Error("Select at least one room to assign.");

  // 1. Look up any existing active assignment for each room (to patch the
  //    previous owner's group and notify them) — reads must happen before
  //    the batch write below, since batches can't read.
  //
  //    NOTE: this includes rooms already owned by the SAME housekeeper. A
  //    brand-new group is always created below (step 3) and every room's
  //    mirror doc is repointed to it (step 4) regardless of who owned it
  //    before — so if we skipped same-owner rooms here, their old group
  //    would never get cleaned up and would linger as a duplicate "active"
  //    entry with stale rooms. We still skip the *notification* for these
  //    (nothing actually changed hands — see step 5).
  const existingSnaps = await Promise.all(rooms.map(r => getDoc(doc(db, "room_assignments", r.id))));
  const displaced = new Map<string, { housekeeperId: string; groupId: string; roomIds: string[]; sameOwner: boolean }>();
  existingSnaps.forEach((snap, i) => {
    if (!snap.exists()) return;
    const data = snap.data() as any;
    const sameOwner = data.housekeeperId === housekeeperId;
    const entry = displaced.get(data.groupId) || { housekeeperId: data.housekeeperId, groupId: data.groupId, roomIds: [] as string[], sameOwner };
    entry.roomIds.push(rooms[i].id);
    displaced.set(data.groupId, entry);
  });

  // 2. Patch every displaced group: remove the moved rooms, and end the
  //    group entirely if nothing is left in it.
  const displacedGroupSnaps = await Promise.all(
    Array.from(displaced.values()).map(d => getDoc(doc(db, "room_assignment_groups", d.groupId)))
  );

  const batch = writeBatch(db);
  const roomNumberById = new Map(rooms.map(r => [r.id, r.number]));

  Array.from(displaced.values()).forEach((d, i) => {
    const groupSnap = displacedGroupSnaps[i];
    if (!groupSnap.exists()) return;
    const groupData = groupSnap.data() as any;
    const remainingRoomIds = (groupData.roomIds || []).filter((id: string) => !d.roomIds.includes(id));
    const remainingRoomNumbers = (groupData.roomNumbers || []).filter((_: string, idx: number) => !d.roomIds.includes(groupData.roomIds[idx]));
    if (remainingRoomIds.length === 0) {
      batch.update(groupSnap.ref, { status: "ended", endedAt: serverTimestamp(), endedBy: actor.id, roomIds: [], roomNumbers: [] });
    } else {
      batch.update(groupSnap.ref, { roomIds: remainingRoomIds, roomNumbers: remainingRoomNumbers, updatedAt: serverTimestamp(), updatedBy: actor.id });
    }
  });

  // 3. Create the new assignment group.
  const groupRef = doc(collection(db, "room_assignment_groups"));
  batch.set(groupRef, {
    housekeeperId,
    housekeeperName,
    roomIds: rooms.map(r => r.id),
    roomNumbers: rooms.map(r => r.number),
    startDate: Timestamp.fromDate(startDate),
    endDate: endDate ? Timestamp.fromDate(endDate) : null,
    notes: notes || null,
    status: "active",
    createdBy: actor.id,
    createdByName: actor.name,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    isDeleted: false,
  });

  // 4. Point the per-room mirror at the new owner.
  for (const room of rooms) {
    batch.set(doc(db, "room_assignments", room.id), {
      roomId: room.id,
      roomNumber: room.number,
      housekeeperId,
      housekeeperName,
      groupId: groupRef.id,
      startDate: Timestamp.fromDate(startDate),
      endDate: endDate ? Timestamp.fromDate(endDate) : null,
      status: "active",
      updatedAt: serverTimestamp(),
    });
  }

  await batch.commit();

  await logAction(
    actor.id, actor.name, "rooms_assigned", "room_assignment_groups", groupRef.id,
    null, { housekeeperId, roomIds: rooms.map(r => r.id) }, actor.role || undefined
  );

  const startLabel = startDate.toISOString().slice(0, 10);
  const endLabel = endDate ? endDate.toISOString().slice(0, 10) : null;
  notifyRoomsAssigned(housekeeperId, housekeeperName, rooms.map(r => r.number), actor.name, startLabel, endLabel).catch(() => {});

  // Notify anyone who actually lost rooms in this operation — skip
  // same-owner entries (step 1), since re-assigning someone's own rooms to
  // themselves (e.g. to change the date range) isn't a reassignment at all.
  displaced.forEach((d) => {
    if (d.sameOwner) return;
    const roomNumbers = d.roomIds.map(id => roomNumberById.get(id) || id);
    notifyRoomsReassigned(d.housekeeperId, roomNumbers, housekeeperName, actor.name).catch(() => {});
  });

  return groupRef.id;
}

/** Ends an assignment group entirely (all its rooms become unassigned). */
export async function endRoomAssignmentGroup(groupId: string, actor: Actor): Promise<void> {
  const groupSnap = await getDoc(doc(db, "room_assignment_groups", groupId));
  if (!groupSnap.exists()) throw new Error("Assignment not found.");
  const data = groupSnap.data() as any;

  const batch = writeBatch(db);
  batch.update(groupSnap.ref, { status: "ended", endedAt: serverTimestamp(), endedBy: actor.id });
  for (const roomId of data.roomIds || []) {
    batch.delete(doc(db, "room_assignments", roomId));
  }
  await batch.commit();

  await logAction(actor.id, actor.name, "room_assignment_ended", "room_assignment_groups", groupId, null, null, actor.role || undefined);
  notifyRoomAssignmentEnded(data.housekeeperId, data.roomNumbers || [], actor.name).catch(() => {});
}

/** Updates the date range / notes on an existing active assignment group. */
export async function updateRoomAssignmentGroup(
  groupId: string,
  updates: { startDate?: Date; endDate?: Date | null; notes?: string | null },
  actor: Actor
): Promise<void> {
  const groupSnap = await getDoc(doc(db, "room_assignment_groups", groupId));
  if (!groupSnap.exists()) throw new Error("Assignment not found.");
  const data = groupSnap.data() as any;

  const patch: Record<string, unknown> = { updatedAt: serverTimestamp(), updatedBy: actor.id };
  if (updates.startDate) patch.startDate = Timestamp.fromDate(updates.startDate);
  if ("endDate" in updates) patch.endDate = updates.endDate ? Timestamp.fromDate(updates.endDate) : null;
  if ("notes" in updates) patch.notes = updates.notes || null;

  const batch = writeBatch(db);
  batch.update(groupSnap.ref, patch);
  for (const roomId of data.roomIds || []) {
    const roomPatch: Record<string, unknown> = { updatedAt: serverTimestamp() };
    if (updates.startDate) roomPatch.startDate = patch.startDate;
    if ("endDate" in updates) roomPatch.endDate = patch.endDate;
    batch.update(doc(db, "room_assignments", roomId), roomPatch);
  }
  await batch.commit();
  await logAction(actor.id, actor.name, "room_assignment_updated", "room_assignment_groups", groupId, null, updates, actor.role || undefined);
}

// ══════════════════════════════════════════════════════════════════════════
// HOUSEKEEPING TASKS — manual creation & lifecycle
// (Automatic creation for checkout/occupied-stay lives server-side in
//  netlify/functions/_shared/housekeepingQueue.ts — Requirements 3 & 4.)
// ══════════════════════════════════════════════════════════════════════════

export interface CreateTaskParams {
  roomId: string;
  roomNumber: string;
  type: HousekeepingTaskType;
  priority: HousekeepingTaskPriority;
  instructions?: string | null;
  assignedTo: string;
  assignedToName: string;
  scheduledFor?: Date;
  actor: Actor;
}

export async function createManualHousekeepingTask(params: CreateTaskParams): Promise<string> {
  const { roomId, roomNumber, type, priority, instructions, assignedTo, assignedToName, scheduledFor, actor } = params;
  // dayKey/weight feed the same fairness accounting the automatic queue uses
  // (see housekeepingBalance.ts + functions/_shared/housekeepingQueue.ts) —
  // a manually-assigned task still counts toward that housekeeper's load for
  // today so the next auto-generated task is balanced against it too. Local
  // browser timezone is an acceptable approximation here (unlike the
  // server-side queue, this never has to decide *whether* a task is due).
  const browserTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const dayKey = dateKeyInTimezone(scheduledFor || new Date(), browserTimezone);
  const weight = computeTaskWeight(type, priority);
  const ref = await addDoc(collection(db, "housekeeping_tasks"), {
    roomId,
    roomNumber,
    type,
    status: "pending",
    priority,
    instructions: instructions || null,
    assignedTo,
    assignedToName,
    assignedBy: actor.id,
    assignedByName: actor.name,
    scheduledFor: Timestamp.fromDate(scheduledFor || new Date()),
    source: "manual",
    bookingId: null,
    dayKey,
    weight,
    homeOwnerId: null,
    homeOwnerName: null,
    rebalanced: false,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    startedAt: null,
    completedAt: null,
    completedBy: null,
    completedByName: null,
    isDeleted: false,
  });
  await logAction(actor.id, actor.name, "housekeeping_task_created", "housekeeping_tasks", ref.id, null, { roomId, assignedTo, priority }, actor.role || undefined);
  notifyHousekeepingTaskQueued(roomNumber, assignedTo, priority, actor.name, instructions).catch(() => {});
  return ref.id;
}

export async function reassignHousekeepingTask(
  taskId: string, toUserId: string, toUserName: string, actor: Actor
): Promise<void> {
  const taskSnap = await getDoc(doc(db, "housekeeping_tasks", taskId));
  if (!taskSnap.exists()) throw new Error("Task not found.");
  const data = taskSnap.data() as any;
  await updateDoc(taskSnap.ref, {
    assignedTo: toUserId,
    assignedToName: toUserName,
    assignedBy: actor.id,
    assignedByName: actor.name,
    updatedAt: serverTimestamp(),
  });
  await logAction(actor.id, actor.name, "housekeeping_task_reassigned", "housekeeping_tasks", taskId, { assignedTo: data.assignedTo }, { assignedTo: toUserId }, actor.role || undefined);
  notifyHousekeepingTaskQueued(data.roomNumber, toUserId, data.priority || "medium", actor.name, data.instructions).catch(() => {});
}

export async function startHousekeepingTask(taskId: string, actor: Actor): Promise<void> {
  await updateDoc(doc(db, "housekeeping_tasks", taskId), {
    status: "in_progress",
    startedAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  await logAction(actor.id, actor.name, "housekeeping_task_started", "housekeeping_tasks", taskId, null, { status: "in_progress" }, actor.role || undefined);
}

/**
 * Marks a task complete. For checkout-driven tasks this also flips the
 * room back to "available" (preserving the existing SOP); occupied-stay
 * service tasks leave the room's status untouched since the guest is
 * still in residence.
 */
export async function completeHousekeepingTask(
  taskId: string,
  room: { id: string; number: string; type: HousekeepingTaskType },
  actor: Actor
): Promise<void> {
  await updateDoc(doc(db, "housekeeping_tasks", taskId), {
    status: "completed",
    completedAt: serverTimestamp(),
    completedBy: actor.id,
    completedByName: actor.name,
    updatedAt: serverTimestamp(),
  });

  if (room.type === "checkout_cleaning" || room.type === "cleaning") {
    await updateRoomStatus(room.id, "available");
  }

  await logAction(actor.id, actor.name, "housekeeping_task_completed", "housekeeping_tasks", taskId, null, { status: "completed" }, actor.role || undefined);
  notifyHousekeepingDone(room.number, actor.name).catch(() => {});
}

export async function skipHousekeepingTask(taskId: string, reason: string, actor: Actor): Promise<void> {
  await updateDoc(doc(db, "housekeeping_tasks", taskId), {
    status: "skipped",
    skipReason: reason || null,
    updatedAt: serverTimestamp(),
  });
  await logAction(actor.id, actor.name, "housekeeping_task_skipped", "housekeeping_tasks", taskId, null, { status: "skipped", reason }, actor.role || undefined);
}

/**
 * Rooms currently assigned to a housekeeper (from the active
 * room_assignments mirror), read directly rather than via a hook so it can
 * be called from event handlers too.
 */
export async function getAssignedRoomIds(housekeeperId: string): Promise<string[]> {
  const snap = await getDocs(query(
    collection(db, "room_assignments"),
    where("housekeeperId", "==", housekeeperId),
    where("status", "==", "active")
  ));
  return snap.docs.map(d => d.id);
}
