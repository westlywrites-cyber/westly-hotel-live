import { describe, it, expect } from "vitest";
import {
  computeTaskWeight,
  chooseAssignee,
  applyLoad,
  type WorkloadEntry,
} from "./housekeepingBalance";

describe("computeTaskWeight", () => {
  it("weights a check-out clean higher than a stay-over service", () => {
    expect(computeTaskWeight("checkout_cleaning", "high")).toBeGreaterThan(
      computeTaskWeight("occupied_service", "medium")
    );
  });

  it("adds a bonus for higher priority", () => {
    const urgent = computeTaskWeight("occupied_service", "urgent");
    const medium = computeTaskWeight("occupied_service", "medium");
    expect(urgent).toBeGreaterThan(medium);
  });
});

describe("chooseAssignee", () => {
  it("leaves a never-zoned room unassigned (unchanged from prior behaviour)", () => {
    const result = chooseAssignee({
      homeOwner: null,
      onDuty: [{ id: "a", name: "Ada", load: 0 }],
      taskWeight: 2,
    });
    expect(result.assignee).toBeNull();
    expect(result.reason).toBe("no_zone");
  });

  it("leaves a task unassigned if nobody is on duty, even with a zone owner", () => {
    const result = chooseAssignee({
      homeOwner: { id: "a", name: "Ada" },
      onDuty: [],
      taskWeight: 2,
    });
    expect(result.assignee).toBeNull();
    expect(result.reason).toBe("no_one_on_duty");
  });

  it("gives the zone owner their own room when loads are balanced", () => {
    const onDuty: WorkloadEntry[] = [
      { id: "a", name: "Ada", load: 2 },
      { id: "b", name: "Bola", load: 2 },
    ];
    const result = chooseAssignee({ homeOwner: { id: "a", name: "Ada" }, onDuty, taskWeight: 2 });
    expect(result.assignee?.id).toBe("a");
    expect(result.rebalanced).toBe(false);
  });

  it("diverts a task away from an already-overloaded zone owner to the lightest on-duty peer", () => {
    const onDuty: WorkloadEntry[] = [
      { id: "a", name: "Ada", load: 10 }, // already well above average
      { id: "b", name: "Bola", load: 1 },
      { id: "c", name: "Chidi", load: 1 },
    ];
    const result = chooseAssignee({ homeOwner: { id: "a", name: "Ada" }, onDuty, taskWeight: 2 });
    expect(result.assignee?.id).toBe("b"); // lightest, tie-broken alphabetically vs "c"
    expect(result.rebalanced).toBe(true);
    expect(result.reason).toBe("rebalanced_overloaded");
  });

  it("tolerates a small imbalance under the threshold rather than moving every extra room", () => {
    const onDuty: WorkloadEntry[] = [
      { id: "a", name: "Ada", load: 4 },
      { id: "b", name: "Bola", load: 3 },
    ];
    // avg = 3.5, cap at 25% = 4.375 — projected 4 + 1 = 5 exceeds it, so this
    // one SHOULD move; drop the task weight so it stays under the cap instead.
    const result = chooseAssignee({ homeOwner: { id: "a", name: "Ada" }, onDuty, taskWeight: 0.25 });
    expect(result.assignee?.id).toBe("a");
    expect(result.rebalanced).toBe(false);
  });

  it("covers the room from someone else when the zone owner isn't on shift today", () => {
    const onDuty: WorkloadEntry[] = [
      { id: "b", name: "Bola", load: 0 },
      { id: "c", name: "Chidi", load: 3 },
    ];
    const result = chooseAssignee({ homeOwner: { id: "a", name: "Ada" }, onDuty, taskWeight: 2 });
    expect(result.assignee?.id).toBe("b");
    expect(result.rebalanced).toBe(true);
    expect(result.reason).toBe("home_owner_off_duty");
  });

  it("never moves work off the zone owner when they're already the lightest-loaded person on duty", () => {
    const onDuty: WorkloadEntry[] = [
      { id: "a", name: "Ada", load: 0 },
      { id: "b", name: "Bola", load: 5 },
    ];
    const result = chooseAssignee({ homeOwner: { id: "a", name: "Ada" }, onDuty, taskWeight: 2 });
    expect(result.assignee?.id).toBe("a");
    expect(result.rebalanced).toBe(false);
  });

  it("keeps the zone owner when they're the only one on duty, regardless of load", () => {
    const onDuty: WorkloadEntry[] = [{ id: "a", name: "Ada", load: 50 }];
    const result = chooseAssignee({ homeOwner: { id: "a", name: "Ada" }, onDuty, taskWeight: 2 });
    expect(result.assignee?.id).toBe("a");
    expect(result.rebalanced).toBe(false);
  });
});

describe("applyLoad", () => {
  it("adds weight to the matching entry and leaves others untouched", () => {
    const onDuty: WorkloadEntry[] = [
      { id: "a", name: "Ada", load: 1 },
      { id: "b", name: "Bola", load: 1 },
    ];
    applyLoad(onDuty, "a", 2);
    expect(onDuty.find(o => o.id === "a")?.load).toBe(3);
    expect(onDuty.find(o => o.id === "b")?.load).toBe(1);
  });

  it("intra-run: successive calls stop everything piling on the same 'currently lightest' person", () => {
    const onDuty: WorkloadEntry[] = [
      { id: "a", name: "Ada", load: 5 },
      { id: "b", name: "Bola", load: 0 },
    ];
    const first = chooseAssignee({ homeOwner: { id: "a", name: "Ada" }, onDuty, taskWeight: 2 });
    expect(first.assignee?.id).toBe("b");
    applyLoad(onDuty, first.assignee!.id, 2);

    const second = chooseAssignee({ homeOwner: { id: "a", name: "Ada" }, onDuty, taskWeight: 2 });
    // Bola is now at 2, Ada at 5 — still lighter than Ada, so Bola picks up
    // the next overflow room too rather than it bouncing back to Ada.
    expect(second.assignee?.id).toBe("b");
  });
});
