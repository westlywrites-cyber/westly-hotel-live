// ══════════════════════════════════════════════════════════════════════════
// HOUSEKEEPING WORKLOAD BALANCING — pure logic (no Firebase imports).
//
// Problem this solves: long-term room ZONES (e.g. "Rooms 1–20 → Housekeeper
// A, 21–40 → B", see room_assignment_groups / assignRoomsToHousekeeper in
// housekeeping.ts) don't account for the fact that occupancy — and
// therefore the actual cleaning workload — changes every day. A zone with
// a lot of check-outs today is a much heavier day than a zone that's
// mostly stay-overs, even though both have 20 rooms on paper.
//
// This module is Firebase-free (same pattern as housekeepingSchedule.ts) so
// the identical weighting/assignment math runs in both places that need
// it — the scheduled queue-generation job
// (functions/_shared/housekeepingQueue.ts) and the read-only "today's
// workload" widget on the client (HousekeepingWorkloadCard) — and so it can
// be unit tested directly (see housekeepingBalance.test.ts).
//
// SCOPE — deliberately narrow, matching how the feature was signed off:
//   • Room ZONES are never touched by this module. A housekeeper's home
//     section (room_assignment_groups) stays exactly as an Operations
//     Manager set it; this only decides who picks up TODAY'S generated
//     task for a room in that zone.
//   • Only applies at the moment a task is being newly created by the
//     automatic queue (checkout / occupied-stay). It never reaches back
//     and moves a task that was assigned in an earlier run, and it never
//     touches a task once a housekeeper has started it ("in_progress") or
//     one an Ops Manager assigned/reassigned by hand — those are always
//     left alone.
//   • Only considers housekeepers who are actually on shift today (per the
//     Shift Scheduling roster) — assigning fresh work to someone who isn't
//     working today would just create a different fairness problem.
// ══════════════════════════════════════════════════════════════════════════

// Mirrors HousekeepingTaskType / HousekeepingTaskPriority in housekeeping.ts.
// Duplicated (rather than imported) on purpose: housekeeping.ts pulls in the
// Firebase client SDK, and this module has to stay import-safe for the
// Cloudflare Worker / Pages Function runtime, exactly like housekeepingSchedule.ts.
export type BalanceTaskType = "checkout_cleaning" | "occupied_service" | "manual" | "maintenance_followup" | "cleaning";
export type BalanceTaskPriority = "low" | "medium" | "high" | "urgent";

/**
 * Effort credits per task type. A check-out clean is a full room reset
 * (strip, remake, deep clean, restock, inspect); an occupied-stay service
 * visit is lighter (tidy, towels, trash, quick bathroom touch-up) — so it
 * shouldn't count the same toward someone's daily load.
 */
export const TASK_TYPE_WEIGHT: Record<BalanceTaskType, number> = {
  checkout_cleaning: 2,
  occupied_service: 1,
  cleaning: 1,
  manual: 1,
  maintenance_followup: 1.5,
};

/**
 * Extra credits for higher-priority work — makes an urgent task visibly
 * move the needle on whoever's holding it, without needing a second
 * dimension in the balancing math below.
 */
export const PRIORITY_WEIGHT_BONUS: Record<BalanceTaskPriority, number> = {
  urgent: 1,
  high: 0.5,
  medium: 0,
  low: 0,
};

export function computeTaskWeight(type: BalanceTaskType, priority: BalanceTaskPriority): number {
  return (TASK_TYPE_WEIGHT[type] ?? 1) + (PRIORITY_WEIGHT_BONUS[priority] ?? 0);
}

/** A housekeeper on shift today, with their running load for the day so far. */
export interface WorkloadEntry {
  id: string;
  name: string;
  /** Sum of task weights already on this person's plate today (pending + in_progress). */
  load: number;
}

/**
 * How far over the on-duty team's average load a housekeeper's zone can run
 * before a NEW task is diverted to someone lighter, instead of landing with
 * the zone owner as usual. 0.25 = up to 25% above average is tolerated —
 * this avoids ping-ponging a single extra room back and forth for a
 * trivial imbalance.
 */
export const DEFAULT_REBALANCE_THRESHOLD = 0.25;

export interface ChooseAssigneeParams {
  /** Whoever holds the long-term room_assignment (zone) for this room, if any. */
  homeOwner: { id: string; name: string } | null;
  /** Housekeepers on shift today, each with their current (running) load. */
  onDuty: WorkloadEntry[];
  taskWeight: number;
  thresholdRatio?: number;
}

export type ChooseAssigneeReason =
  | "no_zone"              // room has no long-term owner at all — left unassigned, same as before
  | "no_one_on_duty"       // nobody is on shift today to give this to
  | "home_owner"           // zone owner takes it as usual — no imbalance
  | "home_owner_off_duty"  // zone owner isn't working today, so it's covered by someone who is
  | "rebalanced_overloaded"; // zone owner is on duty but already over the fairness threshold

export interface ChooseAssigneeResult {
  assignee: { id: string; name: string } | null;
  /** True when the task landed with someone OTHER than the room's home-zone owner. */
  rebalanced: boolean;
  reason: ChooseAssigneeReason;
}

/**
 * Decides who should get a single newly-generated task, given the room's
 * usual zone owner and today's on-duty roster with running loads. Pure
 * function — callers are responsible for calling applyLoad() afterwards so
 * subsequent calls in the same run see the updated picture.
 */
export function chooseAssignee(params: ChooseAssigneeParams): ChooseAssigneeResult {
  const { homeOwner, onDuty, taskWeight, thresholdRatio = DEFAULT_REBALANCE_THRESHOLD } = params;

  if (!homeOwner) {
    return { assignee: null, rebalanced: false, reason: "no_zone" };
  }
  if (onDuty.length === 0) {
    return { assignee: null, rebalanced: false, reason: "no_one_on_duty" };
  }

  const leastLoaded = (): WorkloadEntry =>
    [...onDuty].sort((a, b) => a.load - b.load || a.name.localeCompare(b.name))[0];

  const homeEntry = onDuty.find(o => o.id === homeOwner.id);
  if (!homeEntry) {
    const pick = leastLoaded();
    return { assignee: { id: pick.id, name: pick.name }, rebalanced: true, reason: "home_owner_off_duty" };
  }

  const avgLoad = onDuty.reduce((sum, o) => sum + o.load, 0) / onDuty.length;
  const projectedHomeLoad = homeEntry.load + taskWeight;
  const cap = avgLoad * (1 + thresholdRatio);

  // Nothing to rebalance against yet (start of day), only one person on
  // duty, or the zone owner is still within the tolerated range — keep it
  // with them, same as the original zone-only behaviour.
  if (onDuty.length === 1 || avgLoad === 0 || projectedHomeLoad <= cap) {
    return { assignee: homeOwner, rebalanced: false, reason: "home_owner" };
  }

  const pick = leastLoaded();
  if (pick.id === homeOwner.id) {
    // The zone owner is already the lightest-loaded person on duty —
    // there's nothing fairer to do than leave it with them.
    return { assignee: homeOwner, rebalanced: false, reason: "home_owner" };
  }
  return { assignee: { id: pick.id, name: pick.name }, rebalanced: true, reason: "rebalanced_overloaded" };
}

/**
 * Mutates `onDuty` in place, adding `weight` to the chosen housekeeper's
 * running load — so the NEXT chooseAssignee() call in the same generation
 * run sees an up-to-date picture instead of reusing stale start-of-run
 * numbers (this is what stops, e.g., 10 check-outs in a row all landing on
 * the same "currently least loaded" person).
 */
export function applyLoad(onDuty: WorkloadEntry[], housekeeperId: string, weight: number): void {
  const entry = onDuty.find(o => o.id === housekeeperId);
  if (entry) entry.load += weight;
}
