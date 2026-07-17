import { describe, it, expect } from "vitest";
import {
  occupancyAt,
  crowdMultiplier,
  waitTime,
  capacityPct,
  isOverCapacity,
  kickoffDrift,
  clamp,
  MAX_PENALTY,
  BASE_SERVICE_TIME_MIN,
  OVER_CAPACITY_THRESHOLD,
  MAX_RATIO,
} from "../src/lib/graph/jitter";
import type { JitterParams } from "../src/lib/types";

const params: JitterParams = { base: 3000, amplitude: 1000, period: 200, phase: 0 };
const CAP = 6000;

describe("clamp", () => {
  it("clamps to bounds", () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(11, 0, 10)).toBe(10);
  });
});

describe("kickoffDrift", () => {
  it("peaks at kickoff and falls off symmetrically", () => {
    const amp = 1000;
    const sigma = 1200;
    const k = 3600;
    expect(kickoffDrift(k, k, amp, sigma)).toBeCloseTo(amp);
    // equal distance before/after kickoff => equal drift
    expect(kickoffDrift(k - 600, k, amp, sigma)).toBeCloseTo(
      kickoffDrift(k + 600, k, amp, sigma)
    );
    // far from kickoff => negligible
    expect(kickoffDrift(k + 10000, k, amp, sigma)).toBeLessThan(1);
  });
});

describe("occupancyAt", () => {
  it("is deterministic for a fixed t", () => {
    const a = occupancyAt(params, CAP, 1234);
    const b = occupancyAt(params, CAP, 1234);
    expect(a).toBe(b);
  });

  it("stays within [0, capacity * MAX_RATIO]", () => {
    for (let t = 0; t < 7200; t += 60) {
      const o = occupancyAt(params, CAP, t);
      expect(o).toBeGreaterThanOrEqual(0);
      expect(o).toBeLessThanOrEqual(CAP * MAX_RATIO);
    }
  });

  it("trends up approaching kickoff (drift dominates)", () => {
    // Use a node whose base is low so drift is the clear signal.
    const low: JitterParams = { base: 100, amplitude: 50, period: 300, phase: 0 };
    const early = occupancyAt(low, CAP, 0); // far before kickoff
    const near = occupancyAt(low, CAP, 3600); // at kickoff
    expect(near).toBeGreaterThan(early);
  });
});

describe("crowdMultiplier", () => {
  it("is 1 at zero occupancy", () => {
    expect(crowdMultiplier(0, CAP)).toBe(1);
  });
  it("is 1 + MAX_PENALTY at full capacity", () => {
    expect(crowdMultiplier(CAP, CAP)).toBe(1 + MAX_PENALTY);
  });
  it("is superlinear (quadratic) in the load ratio", () => {
    const half = crowdMultiplier(CAP / 2, CAP);
    const full = crowdMultiplier(CAP, CAP);
    // half-load should be 1 + 0.25*MAX_PENALTY
    expect(half).toBeCloseTo(1 + 0.25 * MAX_PENALTY, 5);
    expect(full).toBeGreaterThan(2 * half - 1); // grows faster than linear
  });
  it("clamps the ratio at MAX_RATIO", () => {
    expect(crowdMultiplier(CAP * 10, CAP)).toBe(
      crowdMultiplier(CAP * MAX_RATIO, CAP)
    );
  });
});

describe("waitTime", () => {
  it("is 0 when empty and BASE_SERVICE_TIME_MIN at full capacity", () => {
    expect(waitTime(0, CAP)).toBe(0);
    expect(waitTime(CAP, CAP)).toBe(BASE_SERVICE_TIME_MIN);
  });
});

describe("capacityPct / isOverCapacity", () => {
  it("clamps to [0, MAX_RATIO]", () => {
    expect(capacityPct(0, CAP)).toBe(0);
    expect(capacityPct(CAP, CAP)).toBe(1);
    expect(capacityPct(CAP * 100, CAP)).toBe(MAX_RATIO);
  });
  it("flags over-capacity at the threshold", () => {
    expect(isOverCapacity(CAP * OVER_CAPACITY_THRESHOLD, CAP)).toBe(true);
    expect(isOverCapacity(CAP * 0.5, CAP)).toBe(false);
  });
});
