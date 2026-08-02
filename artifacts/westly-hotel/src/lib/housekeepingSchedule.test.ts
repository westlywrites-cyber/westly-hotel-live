import { describe, it, expect } from "vitest";
import {
  parseHHMM,
  calendarDateAtLocalTime,
  zonedTimeAt,
  dateKeyInTimezone,
  computeCheckoutTriggerTime,
  computeOccupiedServiceTriggerTime,
  isDue,
  checkoutTaskId,
  occupiedTaskId,
  isAssignmentActiveOn,
  DEFAULT_HOTEL_TIME_SETTINGS,
  type HotelTimeSettings,
} from "./housekeepingSchedule";

const LAGOS_SETTINGS: HotelTimeSettings = {
  ...DEFAULT_HOTEL_TIME_SETTINGS,
  checkOutTime: "11:00",
  housekeepingLeadTimeMinutes: 60,
  timezone: "Africa/Lagos", // UTC+1, no DST — deterministic for tests
};

describe("parseHHMM", () => {
  it("parses valid 24h times", () => {
    expect(parseHHMM("11:00")).toEqual({ hours: 11, minutes: 0 });
    expect(parseHHMM("00:05")).toEqual({ hours: 0, minutes: 5 });
    expect(parseHHMM("23:59")).toEqual({ hours: 23, minutes: 59 });
  });

  it("rejects malformed or out-of-range times", () => {
    expect(() => parseHHMM("25:00")).toThrow();
    expect(() => parseHHMM("11:60")).toThrow();
    expect(() => parseHHMM("11am")).toThrow();
    expect(() => parseHHMM("")).toThrow();
  });
});

describe("calendarDateAtLocalTime", () => {
  it("uses the UTC day carried by the date, unaffected by the target zone's offset", () => {
    // A booking's checkout day, stored as UTC midnight for March 15.
    const checkoutDay = new Date("2026-03-15T00:00:00Z");
    // 11:00 in Lagos (UTC+1) on that same declared day = 10:00 UTC.
    expect(calendarDateAtLocalTime(checkoutDay, "11:00", "Africa/Lagos").toISOString())
      .toBe("2026-03-15T10:00:00.000Z");
    // The declared day must NOT shift even for a zone behind UTC (e.g. New York,
    // EDT = UTC-4 in March) — this is the exact bug class this split prevents.
    expect(calendarDateAtLocalTime(checkoutDay, "11:00", "America/New_York").toISOString())
      .toBe("2026-03-15T15:00:00.000Z");
  });

  it("ignores any time-of-day already present on the input — only the UTC day matters", () => {
    const checkoutDay = new Date("2026-03-15T23:45:00Z");
    expect(calendarDateAtLocalTime(checkoutDay, "11:00", "Africa/Lagos").toISOString())
      .toBe("2026-03-15T10:00:00.000Z");
  });
});

describe("zonedTimeAt", () => {
  it("resolves the real-time calendar day as seen in the target timezone", () => {
    // Just after midnight UTC is already the next day in Lagos (UTC+1).
    const now = new Date("2026-03-15T23:30:00Z");
    const result = zonedTimeAt(now, "09:00", "Africa/Lagos");
    expect(result.toISOString()).toBe("2026-03-16T08:00:00.000Z");
  });
});

describe("dateKeyInTimezone", () => {
  it("formats as YYYY-MM-DD in the given timezone", () => {
    expect(dateKeyInTimezone(new Date("2026-03-15T10:00:00Z"), "Africa/Lagos")).toBe("2026-03-15");
    expect(dateKeyInTimezone(new Date("2026-03-15T23:30:00Z"), "Africa/Lagos")).toBe("2026-03-16");
  });
});

describe("computeCheckoutTriggerTime", () => {
  it("is checkOutTime minus the configured lead time, per Requirement 3's example", () => {
    // Checkout is 11:00, lead time 60 minutes → task should queue at 10:00 local.
    const checkOutDate = new Date("2026-03-15T00:00:00Z");
    const trigger = computeCheckoutTriggerTime(checkOutDate, LAGOS_SETTINGS);
    expect(trigger.toISOString()).toBe("2026-03-15T09:00:00.000Z"); // 10:00 Lagos = 09:00 UTC
  });

  it("shifts automatically when checkOutTime changes (no stale precomputed values)", () => {
    const checkOutDate = new Date("2026-03-15T00:00:00Z");
    const changedSettings: HotelTimeSettings = { ...LAGOS_SETTINGS, checkOutTime: "12:30" };
    const trigger = computeCheckoutTriggerTime(checkOutDate, changedSettings);
    expect(trigger.toISOString()).toBe("2026-03-15T10:30:00.000Z"); // 12:30 - 60min = 11:30 Lagos
  });

  it("shifts automatically when the lead time changes", () => {
    const checkOutDate = new Date("2026-03-15T00:00:00Z");
    const changedSettings: HotelTimeSettings = { ...LAGOS_SETTINGS, housekeepingLeadTimeMinutes: 30 };
    const trigger = computeCheckoutTriggerTime(checkOutDate, changedSettings);
    expect(trigger.toISOString()).toBe("2026-03-15T09:30:00.000Z"); // 11:00 - 30min = 10:30 Lagos
  });
});

describe("computeOccupiedServiceTriggerTime", () => {
  it("resolves to the configured daily service time on now's local day", () => {
    const now = new Date("2026-03-15T06:00:00Z");
    const trigger = computeOccupiedServiceTriggerTime(now, { ...LAGOS_SETTINGS, occupiedStayServiceTime: "10:00" });
    expect(trigger.toISOString()).toBe("2026-03-15T09:00:00.000Z");
  });
});

describe("isDue", () => {
  it("is true at and shortly after the trigger time, within the window", () => {
    const trigger = new Date("2026-03-15T09:00:00Z");
    expect(isDue(trigger, new Date("2026-03-15T09:00:00Z"), 20)).toBe(true);
    expect(isDue(trigger, new Date("2026-03-15T09:10:00Z"), 20)).toBe(true);
  });

  it("is false before the trigger time", () => {
    const trigger = new Date("2026-03-15T09:00:00Z");
    expect(isDue(trigger, new Date("2026-03-15T08:59:00Z"), 20)).toBe(false);
  });

  it("is false once outside the window (a missed run doesn't fire forever)", () => {
    const trigger = new Date("2026-03-15T09:00:00Z");
    expect(isDue(trigger, new Date("2026-03-15T09:25:00Z"), 20)).toBe(false);
  });
});

describe("dedupe key builders", () => {
  it("produce stable, distinct ids", () => {
    expect(checkoutTaskId("bk_123")).toBe("checkout_bk_123");
    expect(occupiedTaskId("room_5", "2026-03-15")).toBe("occupied_room_5_2026-03-15");
    expect(checkoutTaskId("bk_123")).not.toBe(occupiedTaskId("bk_123", "2026-03-15"));
  });
});

describe("isAssignmentActiveOn", () => {
  const tz = "Africa/Lagos";

  it("is active on and between start/end dates (inclusive)", () => {
    const assignment = { startDate: new Date("2026-03-01T00:00:00Z"), endDate: new Date("2026-03-31T00:00:00Z") };
    expect(isAssignmentActiveOn(assignment, new Date("2026-03-01T05:00:00Z"), tz)).toBe(true);
    expect(isAssignmentActiveOn(assignment, new Date("2026-03-15T23:00:00Z"), tz)).toBe(true);
    expect(isAssignmentActiveOn(assignment, new Date("2026-03-31T05:00:00Z"), tz)).toBe(true);
  });

  it("is inactive before start or after end", () => {
    const assignment = { startDate: new Date("2026-03-01T00:00:00Z"), endDate: new Date("2026-03-31T00:00:00Z") };
    expect(isAssignmentActiveOn(assignment, new Date("2026-02-28T05:00:00Z"), tz)).toBe(false);
    expect(isAssignmentActiveOn(assignment, new Date("2026-04-01T05:00:00Z"), tz)).toBe(false);
  });

  it("with a null endDate is active indefinitely into the future", () => {
    const assignment = { startDate: new Date("2026-03-01T00:00:00Z"), endDate: null };
    expect(isAssignmentActiveOn(assignment, new Date("2027-01-01T00:00:00Z"), tz)).toBe(true);
  });
});
