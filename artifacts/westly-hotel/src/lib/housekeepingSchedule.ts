// ══════════════════════════════════════════════════════════════════════════
// HOUSEKEEPING SCHEDULING — pure logic (no Firebase imports).
//
// This module is shared by:
//   • netlify/functions/_shared/housekeepingQueue.ts (the scheduled job that
//     actually creates housekeeping_tasks docs)
//   • the client (to show "next scheduled" hints without a round trip)
//
// Keeping it Firebase-free means it can be unit tested directly (see
// housekeepingSchedule.test.ts) without mocking Firestore, and the exact
// same trigger-time math runs in the browser and on the server so the two
// can never disagree about when a task is "due".
//
// A DELIBERATE DISTINCTION runs through this file, between two kinds of
// Date input:
//   • a "declared calendar date" — e.g. a booking's checkout day, or a
//     long-term assignment's start/end day. These come from a date picker
//     and represent a day, not an instant; this module reads them via their
//     UTC Y-M-D components and never reinterprets them through a timezone
//     lens (that would silently shift the day for hotels west of UTC).
//   • an "instant" — a real moment in time (typically `new Date()` / "now"
//     inside the scheduled job). Its calendar day genuinely does depend on
//     the hotel's timezone, so this module resolves it via Intl.
// Mixing these up is exactly the class of bug this split exists to prevent.
// ══════════════════════════════════════════════════════════════════════════

export interface HotelTimeSettings {
  /** Standard daily check-out time, "HH:MM" 24h, e.g. "11:00". */
  checkOutTime: string;
  /** How many minutes before checkOutTime the cleaning task should be queued. */
  housekeepingLeadTimeMinutes: number;
  /** Daily time-of-day occupied rooms get a housekeeping visit, "HH:MM". */
  occupiedStayServiceTime: string;
  /** Whether daily housekeeping for occupied/extended-stay rooms is on. */
  occupiedStayServiceEnabled: boolean;
  /** IANA timezone the hotel operates in, e.g. "Africa/Lagos". */
  timezone: string;
}

export const DEFAULT_HOTEL_TIME_SETTINGS: HotelTimeSettings = {
  checkOutTime: "11:00",
  housekeepingLeadTimeMinutes: 60,
  occupiedStayServiceTime: "10:00",
  occupiedStayServiceEnabled: true,
  timezone: "Africa/Lagos",
};

const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function parseHHMM(value: string): { hours: number; minutes: number } {
  const match = HHMM_RE.exec((value || "").trim());
  if (!match) {
    throw new Error(`Invalid time "${value}" — expected 24-hour "HH:MM".`);
  }
  return { hours: Number(match[1]), minutes: Number(match[2]) };
}

/**
 * Timezone offset (in minutes, UTC − local) of `timezone` at instant `at`.
 * Positive means the zone is behind UTC.
 */
function getTimezoneOffsetMinutes(timezone: string, at: Date): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const parts = dtf.formatToParts(at);
  const map: Record<string, string> = {};
  for (const p of parts) if (p.type !== "literal") map[p.type] = p.value;
  const asUTC = Date.UTC(
    Number(map.year), Number(map.month) - 1, Number(map.day),
    Number(map.hour), Number(map.minute), Number(map.second)
  );
  return (asUTC - at.getTime()) / 60000;
}

/** Y/M/D carried by a "declared calendar date" Date object (its UTC components). */
function calendarYMD(date: Date): { y: number; m: number; d: number } {
  return { y: date.getUTCFullYear(), m: date.getUTCMonth() + 1, d: date.getUTCDate() };
}

/** Y/M/D of a true instant, as seen "on the ground" in `timezone`. */
function zonedYMD(instant: Date, timezone: string): { y: number; m: number; d: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(instant);
  const get = (t: string) => Number(parts.find(p => p.type === t)!.value);
  return { y: get("year"), m: get("month"), d: get("day") };
}

function ymdToInstant(ymd: { y: number; m: number; d: number }, hhmm: string, timezone: string): Date {
  const { hours, minutes } = parseHHMM(hhmm);
  const utcGuess = Date.UTC(ymd.y, ymd.m - 1, ymd.d, hours, minutes, 0);
  // Correct for the zone's offset at that guessed instant (handles DST edge
  // cases correctly enough for a hotel scheduling use case).
  const offsetMinutes = getTimezoneOffsetMinutes(timezone, new Date(utcGuess));
  return new Date(utcGuess - offsetMinutes * 60000);
}

/**
 * The instant corresponding to `hhmm` local wall-clock time on the day
 * *declared by* `calendarDate` (read from its UTC Y-M-D — see module note).
 * Use this for booking checkout days, assignment start/end days, etc.
 */
export function calendarDateAtLocalTime(calendarDate: Date, hhmm: string, timezone: string): Date {
  return ymdToInstant(calendarYMD(calendarDate), hhmm, timezone);
}

/**
 * The instant corresponding to `hhmm` local wall-clock time on the calendar
 * day that the real moment `instant` falls on, *as seen in* `timezone`.
 * Use this for "now" — e.g. today's occupied-room service time.
 */
export function zonedTimeAt(instant: Date, hhmm: string, timezone: string): Date {
  return ymdToInstant(zonedYMD(instant, timezone), hhmm, timezone);
}

/** "YYYY-MM-DD" of a true instant, as seen in `timezone` — used for dedupe keys. */
export function dateKeyInTimezone(instant: Date, timezone: string): string {
  const { y, m, d } = zonedYMD(instant, timezone);
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/**
 * The instant the pre-checkout cleaning task should be queued: the room's
 * declared checkout day at the hotel's standard checkOutTime, minus the
 * configured lead time. Dynamically re-derived from current settings every
 * call, so changing checkOutTime or the lead time in Settings immediately
 * changes this for every future run — nothing is baked into stored data.
 */
export function computeCheckoutTriggerTime(checkOutDate: Date, settings: HotelTimeSettings): Date {
  const checkoutInstant = calendarDateAtLocalTime(checkOutDate, settings.checkOutTime, settings.timezone);
  return new Date(checkoutInstant.getTime() - settings.housekeepingLeadTimeMinutes * 60000);
}

/** The instant *today's* (i.e. `now`'s local day) occupied-room housekeeping visit should be queued. */
export function computeOccupiedServiceTriggerTime(now: Date, settings: HotelTimeSettings): Date {
  return zonedTimeAt(now, settings.occupiedStayServiceTime, settings.timezone);
}

/**
 * True if `now` has reached `triggerTime` but is still within `windowMinutes`
 * after it. The window exists because the scheduled job polls periodically
 * (not continuously) — it bounds how "late" a task can still be created as
 * on-time rather than silently skipped if a run was missed.
 */
export function isDue(triggerTime: Date, now: Date, windowMinutes = 20): boolean {
  const delta = now.getTime() - triggerTime.getTime();
  return delta >= 0 && delta < windowMinutes * 60000;
}

export function checkoutTaskId(bookingId: string): string {
  return `checkout_${bookingId}`;
}

export function occupiedTaskId(roomId: string, dateKey: string): string {
  return `occupied_${roomId}_${dateKey}`;
}

/** Start-of-day, in `timezone`, of the real moment `now` — i.e. "today" at 00:00 local. */
export function startOfTodayInTimezone(now: Date, timezone: string): Date {
  return zonedTimeAt(now, "00:00", timezone);
}

/** Start-of-day, in `timezone`, of a declared calendar date (assignment start/end, etc). */
function startOfDeclaredDay(calendarDate: Date, timezone: string): Date {
  return calendarDateAtLocalTime(calendarDate, "00:00", timezone);
}

/**
 * Whether a long-term room assignment (start/end dates, end optional =
 * indefinite) is active "today" (`now`, resolved to the hotel's local day).
 */
export function isAssignmentActiveOn(
  assignment: { startDate: Date; endDate: Date | null },
  now: Date,
  timezone: string
): boolean {
  const today = startOfTodayInTimezone(now, timezone).getTime();
  const startDay = startOfDeclaredDay(assignment.startDate, timezone).getTime();
  if (today < startDay) return false;
  if (!assignment.endDate) return true;
  const endDay = startOfDeclaredDay(assignment.endDate, timezone).getTime();
  return today <= endDay;
}
