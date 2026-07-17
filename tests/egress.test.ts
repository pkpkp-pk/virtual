import { describe, it, expect } from "vitest";
import {
  egressPhase,
  egressBoost,
  occupancyAt,
  DEFAULT_KICKOFF_T,
  EGRESS_ONSET_S,
  EGRESS_PEAK_OFFSET_S,
} from "@/lib/graph/jitter";
import {
  findRoute,
} from "@/lib/graph/pathfinder";
import {
  occupancyAtTime,
  nodeOccupancyAt,
  NODE_MAP,
  JITTER_MAP,
} from "@/lib/graph/stadiumGraph";
import type { OccupancyState } from "@/lib/types";

// Egress is a second crowd problem layered on the same engine: after kickoff
// the model inverts — sections depopulate, exits/transit jam. All pure functions
// of t, so fully testable without a live source.

describe("egressPhase", () => {
  it("is arrival before kickoff + onset", () => {
    expect(egressPhase(0)).toBe("arrival");
    expect(egressPhase(DEFAULT_KICKOFF_T)).toBe("arrival");
    expect(egressPhase(DEFAULT_KICKOFF_T + EGRESS_ONSET_S)).toBe("arrival");
  });
  it("is egress after kickoff + onset", () => {
    expect(egressPhase(DEFAULT_KICKOFF_T + EGRESS_ONSET_S + 1)).toBe("egress");
    expect(egressPhase(DEFAULT_KICKOFF_T + 4000)).toBe("egress");
  });
});

describe("egressBoost", () => {
  it("peaks at kickoff + EGRESS_PEAK_OFFSET_S and falls off symmetrically", () => {
    const cap = 6000;
    const peak = egressBoost(cap, DEFAULT_KICKOFF_T + EGRESS_PEAK_OFFSET_S);
    const before = egressBoost(cap, DEFAULT_KICKOFF_T + EGRESS_PEAK_OFFSET_S - 600);
    const after = egressBoost(cap, DEFAULT_KICKOFF_T + EGRESS_PEAK_OFFSET_S + 600);
    expect(peak).toBeGreaterThan(before);
    expect(peak).toBeGreaterThan(after);
    expect(before).toBeCloseTo(after, 5); // symmetric
  });
  it("is negligible far from the egress peak", () => {
    const cap = 6000;
    expect(egressBoost(cap, 0)).toBeLessThan(cap * 0.01);
  });
});

describe("nodeOccupancyAt — phase behavior", () => {
  it("depopulates sections during egress", () => {
    const tEgress = DEFAULT_KICKOFF_T + EGRESS_ONSET_S + 600;
    expect(egressPhase(tEgress)).toBe("egress");
    const secArrival = nodeOccupancyAt("sec_126", DEFAULT_KICKOFF_T);
    const secEgress = nodeOccupancyAt("sec_126", tEgress);
    // Egress section load is roughly the arrival model scaled down to 30%,
    // so it should be materially lower than the arrival-time load.
    expect(secEgress).toBeLessThanOrEqual(Math.round(secArrival * 0.35));
  });

  it("jams gates/transit during egress more than the arrival model at the same time", () => {
    const tEgress = DEFAULT_KICKOFF_T + EGRESS_PEAK_OFFSET_S; // peak crush
    // Isolate the egress boost: compare the phase-aware load to the raw
    // arrival model at the same instant (no egress boost).
    const cap = NODE_MAP["gate_d"].capacity;
    const gateArrivalOnly = Math.round(occupancyAt(JITTER_MAP["gate_d"], cap, tEgress));
    const gateEgress = nodeOccupancyAt("gate_d", tEgress);
    expect(gateEgress).toBeGreaterThan(gateArrivalOnly);
    // Transit nodes should be loaded during egress (they're near-empty on arrival).
    const transitEgress = nodeOccupancyAt("nj_transit", tEgress);
    const transitArrival = nodeOccupancyAt("nj_transit", 0);
    expect(transitEgress).toBeGreaterThan(transitArrival);
  });

  it("matches occupancyAtTime entry-for-entry (single source of truth)", () => {
    const t = DEFAULT_KICKOFF_T + 4000;
    const snap = occupancyAtTime(t);
    for (const id of Object.keys(NODE_MAP)) {
      expect(snap[id]).toBe(nodeOccupancyAt(id, t));
    }
  });
});

describe("egress routing", () => {
  function occ(t: number): OccupancyState {
    return occupancyAtTime(t);
  }

  it("routes a section to NJ Transit during egress and the path reaches the transit node", () => {
    const tEgress = DEFAULT_KICKOFF_T + EGRESS_PEAK_OFFSET_S;
    const res = findRoute({
      from: "sec_126",
      to: "nj_transit",
      occupancy: occ(tEgress),
    });
    expect(res.status).toBe("ok");
    expect(res.winner).not.toBeNull();
    expect(res.winner!.path.at(-1)).toBe("nj_transit");
    expect(res.winner!.path[0]).toBe("sec_126");
  });

  it("routes from a transit node to a section during arrival (gate ranking still applies)", () => {
    const res = findRoute({
      from: "nj_transit",
      to: "sec_126",
      occupancy: occ(60),
    });
    expect(res.status).toBe("ok");
    expect(res.winner).not.toBeNull();
    expect(res.winner!.path[0]).toBe("nj_transit");
    expect(res.winner!.path.at(-1)).toBe("sec_126");
    // Transit origins are treated like entry: gate ranking gives a runner-up
    // via a different gate.
    expect(res.winner!.gateCapacities.length).toBeGreaterThanOrEqual(1);
  });
});
