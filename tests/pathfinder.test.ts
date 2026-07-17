import { describe, it, expect } from "vitest";
import { findRoute } from "../src/lib/graph/pathfinder";
import { occupancyAtTime, NODE_MAP } from "../src/lib/graph/stadiumGraph";
import type { OccupancyState } from "../src/lib/types";

/** Build an occupancy map: start from the deterministic t=0 snapshot, then
 *  override specific nodes so tests are independent of the jitter phase. */
function occ(overrides: Record<string, number> = {}, t = 0): OccupancyState {
  return { ...occupancyAtTime(t), ...overrides };
}

describe("findRoute — basic routing", () => {
  it("finds a route from entry plaza to a section", () => {
    const res = findRoute({ from: "entry_plaza", to: "sec_126", occupancy: occ() });
    expect(res.status).toBe("ok");
    expect(res.winner).not.toBeNull();
    expect(res.winner!.path[0]).toBe("entry_plaza");
    expect(res.winner!.path[res.winner!.path.length - 1]).toBe("sec_126");
    // trips from the entry plaza always pass through a gate
    expect(res.winner!.gateCapacities.length).toBeGreaterThanOrEqual(1);
  });

  it("returns a runner-up via a different gate", () => {
    const res = findRoute({ from: "entry_plaza", to: "sec_126", occupancy: occ() });
    expect(res.runnerUp).not.toBeNull();
    expect(res.reasonData.winnerGate).toBeDefined();
    expect(res.reasonData.runnerUpGate).toBeDefined();
    expect(res.reasonData.winnerGate).not.toBe(res.reasonData.runnerUpGate);
    // winner is (by definition) no more costly than the runner-up
    expect(res.winner!.totalCost).toBeLessThanOrEqual(res.runnerUp!.totalCost);
  });

  it("winner path is contiguous and uses real edges", () => {
    const res = findRoute({ from: "entry_plaza", to: "sec_125", occupancy: occ() });
    const path = res.winner!.path;
    for (let i = 0; i < path.length - 1; i++) {
      const seg = res.winner!.segments.find(
        (s) => s.from === path[i] && s.to === path[i + 1]
      );
      expect(seg, `segment ${path[i]}->${path[i + 1]} should exist`).toBeDefined();
    }
  });
});

describe("findRoute — crowd-aware gate choice", () => {
  it("avoids a jammed nearby gate in favor of an emptier one", () => {
    // Jam gate_c (geometrically near sec_126) and keep gate_d emptier.
    const occupancy = occ({
      gate_c: 5600, // ~93% of 6000 -> over capacity, crowdMultiplier ~5
      gate_d: 600, // ~10% -> nearly free
      gate_a: 3000,
      gate_b: 3000,
      gate_vip: 800,
    });
    const res = findRoute({ from: "entry_plaza", to: "sec_126", occupancy });

    expect(res.status).toBe("ok");
    expect(res.reasonData.winnerGate).not.toBe("gate_c");
    // The jammed gate should appear among the over-capacity gates
    expect(res.reasonData.overCapacityGates.map((g) => g.id)).toContain("gate_c");
  });

  it("prefers a closer gate when crowds are equal", () => {
    // Equal, low occupancy everywhere -> winner should be a geographically
    // close gate to sec_126 (gate_c or gate_d), not the far VIP gate.
    const occupancy = occ({
      gate_a: 1000,
      gate_b: 1000,
      gate_c: 1000,
      gate_d: 1000,
      gate_vip: 1000,
    });
    const res = findRoute({ from: "entry_plaza", to: "sec_126", occupancy });
    expect(res.reasonData.winnerGate).not.toBe("gate_vip");
  });
});

describe("findRoute — already inside the venue", () => {
  it("routes from a gate to a section without re-routing through another gate", () => {
    const res = findRoute({ from: "gate_c", to: "sec_126", occupancy: occ() });
    expect(res.status).toBe("ok");
    expect(res.winner!.path[0]).toBe("gate_c");
    // path should not detour out to a different gate
    const gatesOnPath = res.winner!.path.filter(
      (id) => NODE_MAP[id].type === "gate"
    );
    expect(gatesOnPath).toEqual(["gate_c"]);
  });
});

describe("findRoute — determinism", () => {
  it("returns identical results for identical inputs", () => {
    const occupancy = occ({ gate_c: 5600, gate_d: 600 });
    const a = findRoute({ from: "entry_plaza", to: "sec_126", occupancy });
    const b = findRoute({ from: "entry_plaza", to: "sec_126", occupancy });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("exposes the full gate ranking (allGates), winner first, sorted by cost", () => {
    const res = findRoute({ from: "entry_plaza", to: "sec_126", occupancy: occ() });
    expect(res.allGates).toBeDefined();
    expect(res.allGates!.length).toBeGreaterThanOrEqual(2);
    expect(res.allGates![0].gate).toBe(res.reasonData.winnerGate);
    for (let i = 1; i < res.allGates!.length; i++) {
      expect(res.allGates![i].totalCost).toBeGreaterThanOrEqual(
        res.allGates![i - 1].totalCost
      );
    }
  });
});
