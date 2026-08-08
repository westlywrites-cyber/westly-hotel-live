import { describe, it, expect } from "vitest";
import { datesOverlap, findConflictInDocs } from "./roomLogic";

// Helper to build a fake Firestore-doc-shaped object (id + data()), matching
// the minimal shape findConflictInDocs() actually depends on — the same
// shape both QuerySnapshot.docs (getDocs) and transaction.get(query).docs
// share in the real code.
function fakeDoc(id: string, checkIn: string, checkOut: string) {
  return {
    id,
    data: () => ({ checkIn: new Date(checkIn), checkOut: new Date(checkOut) }),
  };
}

describe("datesOverlap", () => {
  it("is not a conflict when the new check-in equals the existing check-out (same-day turnover)", () => {
    // Existing booking: Jan 1 -> Jan 5. New booking starts exactly when it ends.
    expect(
      datesOverlap(new Date("2026-01-01"), new Date("2026-01-05"), new Date("2026-01-05"), new Date("2026-01-08"))
    ).toBe(false);
  });

  it("is not a conflict when the new check-out equals the existing check-in (same-day turnover, reversed)", () => {
    expect(
      datesOverlap(new Date("2026-01-05"), new Date("2026-01-08"), new Date("2026-01-01"), new Date("2026-01-05"))
    ).toBe(false);
  });

  it("is a conflict on full overlap (new range entirely inside existing range)", () => {
    expect(
      datesOverlap(new Date("2026-01-01"), new Date("2026-01-10"), new Date("2026-01-03"), new Date("2026-01-06"))
    ).toBe(true);
  });

  it("is a conflict on full overlap (existing range entirely inside new range)", () => {
    expect(
      datesOverlap(new Date("2026-01-03"), new Date("2026-01-06"), new Date("2026-01-01"), new Date("2026-01-10"))
    ).toBe(true);
  });

  it("is a conflict on partial overlap — new range starts before and ends inside existing range", () => {
    expect(
      datesOverlap(new Date("2026-01-05"), new Date("2026-01-10"), new Date("2026-01-01"), new Date("2026-01-07"))
    ).toBe(true);
  });

  it("is a conflict on partial overlap — new range starts inside and ends after existing range", () => {
    expect(
      datesOverlap(new Date("2026-01-01"), new Date("2026-01-05"), new Date("2026-01-03"), new Date("2026-01-10"))
    ).toBe(true);
  });

  it("is not a conflict when the ranges are entirely separate", () => {
    expect(
      datesOverlap(new Date("2026-01-01"), new Date("2026-01-03"), new Date("2026-01-10"), new Date("2026-01-12"))
    ).toBe(false);
  });
});

describe("findConflictInDocs", () => {
  it("returns false when there are no existing booking_dates docs", () => {
    expect(findConflictInDocs([], new Date("2026-01-01"), new Date("2026-01-05"))).toBe(false);
  });

  it("returns true when an existing doc overlaps the requested range", () => {
    const docs = [fakeDoc("BK-1", "2026-01-03", "2026-01-06")];
    expect(findConflictInDocs(docs, new Date("2026-01-01"), new Date("2026-01-10"))).toBe(true);
  });

  it("returns false when only same-day-turnover boundary docs exist", () => {
    const docs = [fakeDoc("BK-1", "2026-01-01", "2026-01-05")];
    expect(findConflictInDocs(docs, new Date("2026-01-05"), new Date("2026-01-08"))).toBe(false);
  });

  it("skips the doc matching excludeBookingId (editing a booking against itself)", () => {
    const docs = [fakeDoc("BK-1", "2026-01-01", "2026-01-10")];
    // Without the exclude, this would conflict with itself.
    expect(findConflictInDocs(docs, new Date("2026-01-01"), new Date("2026-01-10"), "BK-1")).toBe(false);
  });

  it("still detects a conflict from a different doc even when excludeBookingId is set", () => {
    const docs = [fakeDoc("BK-1", "2026-01-01", "2026-01-10"), fakeDoc("BK-2", "2026-01-02", "2026-01-04")];
    expect(findConflictInDocs(docs, new Date("2026-01-01"), new Date("2026-01-10"), "BK-1")).toBe(true);
  });
});
