import { describe, it, expect } from "vitest";
import { findRoute } from "../src/lib/graph/pathfinder";
import { occupancyAtTime, NODE_MAP } from "../src/lib/graph/stadiumGraph";
import { isOverCapacity } from "../src/lib/graph/jitter";
import type { OccupancyState } from "../src/lib/types";

function occ(overrides: Record<string, number> = {}, t = 0): OccupancyState {
  return { ...occupancyAtTime(t), ...overrides };
}

describe("edge case — all routes over capacity", () => {
  it("reports all_over_capacity when every reachable gate is jammed", () => {
    // Every gate >= 90% of its 6000 capacity.
    const occupancy = occ({
      gate_a: 5500,
      gate_b: 5600,
      gate_c: 5700,
      gate_d: 5400,
      gate_vip: 1900, // 95% of 2000
    });
    const res = findRoute({ from: "entry_plaza", to: "sec_126", occupancy });

    expect(res.status).toBe("all_over_capacity");
    // Still returns a least-bad winner so the XAI layer can recommend wait vs detour
    expect(res.winner).not.toBeNull();
    // every reachable gate is over capacity
    for (const g of res.reasonData.overCapacityGates) {
      expect(isOverCapacity(g.occupancy, g.capacity)).toBe(true);
    }
  });
});

describe("edge case — no accessible path", () => {
  it("reports no_accessible_path when the destination is stair-only", () => {
    const res = findRoute({
      from: "entry_plaza",
      to: "sec_300", // accessible=false, only stair edges
      constraints: { accessible: true },
      occupancy: occ(),
    });
    expect(res.status).toBe("no_accessible_path");
    expect(res.winner).toBeNull();
    // Reference route (non-accessible) exists so the XAI layer can explain the blocker
    expect(res.referenceRoute).not.toBeNull();
    expect(res.referenceRoute!.path.at(-1)).toBe("sec_300");
    // and it actually uses a non-accessible (stairs) segment
    expect(
      res.referenceRoute!.segments.some((s) => s.accessible === false)
    ).toBe(true);
  });

  it("still routes accessibly to an accessible section, using only accessible segments", () => {
    const res = findRoute({
      from: "entry_plaza",
      to: "sec_126",
      constraints: { accessible: true },
      occupancy: occ(),
    });
    expect(res.status).toBe("ok");
    expect(res.winner).not.toBeNull();
    for (const s of res.winner!.segments) {
      expect(s.accessible).toBe(true);
    }
    // path never includes a non-accessible node
    for (const id of res.winner!.path) {
      expect(NODE_MAP[id].accessible).toBe(true);
    }
  });
});

describe("edge case — gate closes mid-session", () => {
  it("excludes a closed gate and reroutes", () => {
    // Two empty gates (b, vip), three jammed -> winner is one of the empty ones.
    const occupancy = occ({
      gate_a: 5500,
      gate_b: 600,
      gate_c: 5500,
      gate_d: 5500,
      gate_vip: 600,
    });
    const open = findRoute({ from: "entry_plaza", to: "sec_126", occupancy });
    const openGate = open.reasonData.winnerGate!;
    expect(openGate).toBeDefined();
    expect(["gate_b", "gate_vip"]).toContain(openGate);

    // Close the winning gate mid-session.
    const closed = findRoute({
      from: "entry_plaza",
      to: "sec_126",
      occupancy,
      closedGates: [openGate],
    });
    expect(closed.status).toBe("ok");
    expect(closed.reasonData.winnerGate).not.toBe(openGate);
    expect(closed.closedGates).toEqual([openGate]);
    expect(closed.winner!.path).not.toContain(openGate);
  });

  it("reports no_path when the origin itself is closed", () => {
    const res = findRoute({
      from: "gate_c",
      to: "sec_126",
      occupancy: occ(),
      closedGates: ["gate_c"],
    });
    expect(res.status).toBe("no_path");
    expect(res.winner).toBeNull();
  });
});
