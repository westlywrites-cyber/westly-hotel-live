import { type Env, fsGet, fsQuery, fsCreate, serverTimestamp } from "./firebaseRest";
import { serverNotify } from "./serverNotify";
import {
  DEFAULT_HOTEL_TIME_SETTINGS, type HotelTimeSettings,
  computeCheckoutTriggerTime, computeOccupiedServiceTriggerTime, isDue,
  dateKeyInTimezone, checkoutTaskId, occupiedTaskId, isAssignmentActiveOn,
} from "../../src/lib/housekeepingSchedule";

interface RunResult {
  ranAt: string;
  checkoutTasksCreated: number;
  occupiedServiceTasksCreated: number;
  skippedAlreadyExisted: number;
  unassignedCount: number;
  errors: string[];
}

async function loadHotelTimeSettings(env: Env): Promise<HotelTimeSettings> {
  const snap = await fsGet(env, "settings", "hotel");
  const data = snap.exists ? snap.data() : {};
  return {
    checkOutTime: data.checkOutTime || DEFAULT_HOTEL_TIME_SETTINGS.checkOutTime,
    housekeepingLeadTimeMinutes: data.housekeepingLeadTimeMinutes ?? DEFAULT_HOTEL_TIME_SETTINGS.housekeepingLeadTimeMinutes,
    occupiedStayServiceTime: data.occupiedStayServiceTime || DEFAULT_HOTEL_TIME_SETTINGS.occupiedStayServiceTime,
    occupiedStayServiceEnabled: data.occupiedStayServiceEnabled !== false,
    timezone: data.timezone || DEFAULT_HOTEL_TIME_SETTINGS.timezone,
  };
}

/** Whoever currently holds the long-term assignment for a room, if any. */
async function findCurrentAssignee(
  env: Env, roomId: string, now: Date, timezone: string
): Promise<{ id: string; name: string } | null> {
  const mirrorSnap = await fsGet(env, "room_assignments", roomId);
  if (!mirrorSnap.exists) return null;
  const data = mirrorSnap.data();
  if (data.status !== "active") return null;
  const startDate: Date = data.startDate instanceof Date ? data.startDate : new Date(data.startDate);
  const endDate: Date | null = data.endDate ? (data.endDate instanceof Date ? data.endDate : new Date(data.endDate)) : null;
  if (!isAssignmentActiveOn({ startDate, endDate }, now, timezone)) return null;
  return { id: data.housekeeperId, name: data.housekeeperName };
}

/**
 * Creates a housekeeping_tasks doc if (and only if) one doesn't already
 * exist at `taskId` — using Firestore's create-with-precondition (which
 * fails atomically if the doc exists) rather than a read-then-write, so
 * concurrent/overlapping runs of this job can never double-create the same
 * task.
 */
async function createTaskIfAbsent(env: Env, taskId: string, data: Record<string, any>): Promise<boolean> {
  return fsCreate(env, "housekeeping_tasks", taskId, data);
}

/**
 * Requirement 3 — queues a checkout-cleaning task for every checked-in
 * booking whose (checkOutTime − leadTime) trigger has just been reached.
 * Re-derives the trigger from CURRENT settings every run, so a Super Admin
 * changing checkOutTime or the lead time takes effect on the very next run
 * with no other action needed.
 */
async function generateCheckoutTasks(env: Env, now: Date, settings: HotelTimeSettings, result: RunResult) {
  const bookingsSnap = await fsQuery(env, "bookings", [{ field: "status", op: "==", value: "checked_in" }]);

  for (const bookingDoc of bookingsSnap) {
    const booking = bookingDoc.data();
    if (!booking.checkOut || !booking.roomId) continue;

    const checkOutDate: Date = booking.checkOut instanceof Date ? booking.checkOut : new Date(booking.checkOut);
    const trigger = computeCheckoutTriggerTime(checkOutDate, settings);
    if (!isDue(trigger, now)) continue;

    const taskId = checkoutTaskId(bookingDoc.id);
    const roomSnap = await fsGet(env, "rooms", booking.roomId);
    const roomNumber = roomSnap.exists ? roomSnap.data().number : booking.roomId;

    const assignee = await findCurrentAssignee(env, booking.roomId, now, settings.timezone);

    const created = await createTaskIfAbsent(env, taskId, {
      roomId: booking.roomId,
      roomNumber,
      type: "checkout_cleaning",
      status: "pending",
      priority: "high",
      instructions: null,
      assignedTo: assignee?.id ?? null,
      assignedToName: assignee?.name ?? null,
      assignedBy: "system",
      assignedByName: "Automatic Queue",
      scheduledFor: trigger,
      bookingId: bookingDoc.id,
      source: "auto_checkout",
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      startedAt: null,
      completedAt: null,
      completedBy: null,
      completedByName: null,
      isDeleted: false,
    });

    if (!created) {
      result.skippedAlreadyExisted++;
      continue;
    }
    result.checkoutTasksCreated++;

    if (assignee) {
      await serverNotify(env, {
        type: "housekeeping_task_scheduled",
        title: "New Cleaning Task",
        message: `Room ${roomNumber} needs check-out cleaning (high priority) — guest departs soon.`,
        forUserIds: [assignee.id],
        severity: "warning",
        link: "/admin/housekeeping",
      }).catch((e) => result.errors.push(String(e)));
    } else {
      result.unassignedCount++;
    }
  }
}

/**
 * Requirement 4 — for every currently-occupied room (guest checked in and
 * not yet checked out, including stays that have been extended past their
 * original date), queues one daily service task at the configured time.
 * One task per room per hotel-local day (dedupe key includes the date).
 */
async function generateOccupiedServiceTasks(env: Env, now: Date, settings: HotelTimeSettings, result: RunResult) {
  if (!settings.occupiedStayServiceEnabled) return;

  const trigger = computeOccupiedServiceTriggerTime(now, settings);
  if (!isDue(trigger, now)) return;

  const dateKey = dateKeyInTimezone(now, settings.timezone);
  const bookingsSnap = await fsQuery(env, "bookings", [{ field: "status", op: "==", value: "checked_in" }]);

  // A room already has a checkout task in flight today doesn't also need a
  // separate occupied-service visit queued in the same run.
  const seenRoomIds = new Set<string>();

  for (const bookingDoc of bookingsSnap) {
    const booking = bookingDoc.data();
    if (!booking.roomId || seenRoomIds.has(booking.roomId)) continue;
    seenRoomIds.add(booking.roomId);

    const checkoutTaskSnap = await fsGet(env, "housekeeping_tasks", checkoutTaskId(bookingDoc.id));
    if (checkoutTaskSnap.exists && checkoutTaskSnap.data()?.status !== "completed" && checkoutTaskSnap.data()?.status !== "skipped") {
      continue; // a checkout cleaning is already pending/in progress for this room today
    }

    const taskId = occupiedTaskId(booking.roomId, dateKey);
    const roomSnap = await fsGet(env, "rooms", booking.roomId);
    const roomNumber = roomSnap.exists ? roomSnap.data().number : booking.roomId;

    const assignee = await findCurrentAssignee(env, booking.roomId, now, settings.timezone);

    const created = await createTaskIfAbsent(env, taskId, {
      roomId: booking.roomId,
      roomNumber,
      type: "occupied_service",
      status: "pending",
      priority: "medium",
      instructions: "Guest is in-house — service the room without disturbing personal belongings.",
      assignedTo: assignee?.id ?? null,
      assignedToName: assignee?.name ?? null,
      assignedBy: "system",
      assignedByName: "Automatic Queue",
      scheduledFor: trigger,
      bookingId: bookingDoc.id,
      source: "auto_occupied_stay",
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      startedAt: null,
      completedAt: null,
      completedBy: null,
      completedByName: null,
      isDeleted: false,
    });

    if (!created) {
      result.skippedAlreadyExisted++;
      continue;
    }
    result.occupiedServiceTasksCreated++;

    if (assignee) {
      await serverNotify(env, {
        type: "housekeeping_task_scheduled",
        title: "New Cleaning Task",
        message: `Room ${roomNumber} is due for its daily occupied-room service.`,
        forUserIds: [assignee.id],
        severity: "info",
        link: "/admin/housekeeping",
      }).catch((e) => result.errors.push(String(e)));
    } else {
      result.unassignedCount++;
    }
  }
}

export async function runHousekeepingQueueGeneration(env: Env, now: Date = new Date()): Promise<RunResult> {
  const result: RunResult = {
    ranAt: now.toISOString(),
    checkoutTasksCreated: 0,
    occupiedServiceTasksCreated: 0,
    skippedAlreadyExisted: 0,
    unassignedCount: 0,
    errors: [],
  };

  const settings = await loadHotelTimeSettings(env);

  try {
    await generateCheckoutTasks(env, now, settings, result);
  } catch (err: any) {
    result.errors.push(`checkout tasks: ${err?.message || err}`);
  }

  try {
    await generateOccupiedServiceTasks(env, now, settings, result);
  } catch (err: any) {
    result.errors.push(`occupied-service tasks: ${err?.message || err}`);
  }

  if (result.unassignedCount > 0) {
    // Let Operations Managers / management know some auto-generated tasks
    // need a human to pick an assignee (no active room assignment existed).
    const opsManagers = await fsQuery(env, "users", [
      { field: "role", op: "in", value: ["operations_manager", "super_admin"] },
      { field: "status", op: "==", value: "active" },
    ]);
    const opsIds = opsManagers.map((d) => d.id);
    if (opsIds.length > 0) {
      await serverNotify(env, {
        type: "housekeeping_task_scheduled",
        title: "Unassigned Housekeeping Tasks",
        message: `${result.unassignedCount} housekeeping task(s) were queued for rooms with no active room assignment. Assign them from Room Assignments.`,
        forUserIds: opsIds,
        severity: "warning",
        link: "/admin/housekeeping/assignments",
      }).catch((e) => result.errors.push(String(e)));
    }
  }

  return result;
}
