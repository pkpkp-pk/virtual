import { describe, it, expect } from "vitest";
import {
  forecastNode,
  gateWaitRecommendation,
  CALM_THRESHOLD,
} from "@/lib/graph/forecast";
import { JITTER_MAP, NODE_MAP } from "@/lib/graph/stadiumGraph";
import { occupancyAt, OVER_CAPACITY_THRESHOLD } from "@/lib/graph/jitter";
import type { RouteResult } from "@/lib/types";

// Forecasting reuses the pure jitter(t) model, so it is deterministic for a
// fixed scenario time and unit-testable without any live source.

describe("forecastNode", () => {
  it("is deterministic for a fixed t (same input -> same output)", () => {
    const a = forecastNode("gate_c", 3500, 15, 1);
    const b = forecastNode("gate_c", 3500, 15, 1);
    expect(a).toEqual(b);
  });

  it("reports the 'now' value equal to the jitter model at fromT", () => {
    const t = 3500;
    const fc = forecastNode("gate_c", t, 15, 1);
    const cap = NODE_MAP["gate_c"].capacity;
    expect(fc.now.occupancy).toBe(Math.round(occupancyAt(JITTER_MAP["gate_c"], cap, t)));
  });

  it("emits one projection per step up to the horizon", () => {
    const fc = forecastNode("gate_c", 3500, 10, 2);
    expect(fc.projections).toHaveLength(5); // 2,4,6,8,10
    expect(fc.projections.map((p) => p.deltaMin)).toEqual([2, 4, 6, 8, 10]);
  });

  it("sets clearsBelowThresholdAtMin when a temporarily-jammed gate calms down post-kickoff", () => {
    // gate_d has a low base (0.5) so it is jammed only because of the kickoff
    // drift bump; once the drift decays it falls well below the calm threshold.
    const t = 3600; // kickoff peak -> gate_d is jammed here
    const fc = forecastNode("gate_d", t, 25, 1);
    expect(fc.overCapacityNow).toBe(true);
    expect(fc.clearsBelowThresholdAtMin).toBeGreaterThanOrEqual(1);
    const clearPoint = fc.projections.find(
      (p) => p.deltaMin === fc.clearsBelowThresholdAtMin
    );
    expect(clearPoint).toBeDefined();
    expect(clearPoint!.capacityPct).toBeLessThan(CALM_THRESHOLD);
  });

  it("leaves clearsBelowThresholdAtMin undefined when a hot gate never calms below the threshold", () => {
    // gate_c has a high base (0.85 -> floor ~0.73) so it never drops below 0.7.
    const t = 3600;
    const fc = forecastNode("gate_c", t, 20, 1);
    expect(fc.overCapacityNow).toBe(true);
    expect(fc.clearsBelowThresholdAtMin).toBeUndefined();
  });

  it("leaves clearsBelowThresholdAtMin undefined when not jammed now", () => {
    const fc = forecastNode("amen_firstaid_w", 3600, 15, 1);
    if (!fc.overCapacityNow) {
      expect(fc.clearsBelowThresholdAtMin).toBeUndefined();
    }
  });

  it("returns an empty forecast for an unknown node instead of throwing", () => {
    const fc = forecastNode("does_not_exist", 3600, 10, 1);
    expect(fc.projections).toEqual([]);
    expect(fc.now.occupancy).toBe(0);
  });
});

describe("gateWaitRecommendation", () => {
  function fakeRoute(gateId: string, occupancy: number): RouteResult {
    const cap = NODE_MAP[gateId].capacity;
    return {
      path: ["entry_plaza", gateId, "junction_c"],
      totalDistance: 200,
      totalCost: 300,
      totalWait: 5,
      segments: [],
      gateCapacities: [
        {
          id: gateId,
          label: NODE_MAP[gateId].label,
          occupancy,
          capacity: cap,
          capacityPct: occupancy / cap,
        },
      ],
    };
  }

  it("returns null when the winner gate is not over capacity", () => {
    const r = fakeRoute("gate_d", 100); // gate_d cap 6000 -> not jammed
    expect(gateWaitRecommendation(r, 3600)).toBeNull();
  });

  it("recommends waiting with a clearsAtMin when the gate is jammed and will clear", () => {
    // gate_d jammed at kickoff (drift bump), calms as drift decays.
    const r = fakeRoute("gate_d", NODE_MAP["gate_d"].capacity * OVER_CAPACITY_THRESHOLD + 50);
    const rec = gateWaitRecommendation(r, 3600);
    expect(rec).not.toBeNull();
    expect(rec!.gateId).toBe("gate_d");
    expect(rec!.clearsAtMin).toBeGreaterThanOrEqual(1);
    expect(rec!.message).toMatch(/%/);
  });

  it("returns a recommendation without clearsAtMin when the gate won't calm soon", () => {
    // gate_c (base 0.85) is jammed and never drops below the calm threshold.
    const r = fakeRoute("gate_c", NODE_MAP["gate_c"].capacity * 0.95);
    const rec = gateWaitRecommendation(r, 3600);
    expect(rec).not.toBeNull();
    expect(rec!.clearsAtMin).toBeUndefined();
    expect(rec!.message).toMatch(/not forecast to clear/i);
  });
});
