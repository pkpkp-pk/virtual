// Deterministic, time-based crowd simulation.
//
// occupancy(t) is a PURE function of wall-clock scenario time t. This is what
// makes the system genuinely dynamic without a user touching anything: any
// read/render recomputes the current occupancy, so the UI evolves at sub-minute
// granularity even though the Firestore writer only ticks once per minute
// (the Cloud Scheduler floor).
//
//   occupancy(t) = base
//                + amplitude * sin(2π t / period + phase)   // per-node liveliness
//                + driftAmp  * gauss(t - kickoff)            // surge toward kickoff
//   clamped to [0, capacity * 1.2]
//
// crowdMultiplier and waitTime derive from occupancy/capacity.

import type { JitterParams } from "../types";

/** Superlinear penalty cap: a fully jammed node multiplies edge cost by this. */
export const MAX_PENALTY = 4;
/** Estimated minutes of waiting when a node is at 100% capacity. */
export const BASE_SERVICE_TIME_MIN = 8;
/** occupancy/capacity ratio at/above which a gate counts as "over capacity". */
export const OVER_CAPACITY_THRESHOLD = 0.9;
/** Clamp ratio so a node can read slightly over its nominal capacity. */
export const MAX_RATIO = 1.2;

/** Scenario clock defaults (seconds). Kickoff 1h into the scenario; the surge
 *  bump spans ~40 min (2*sigma each side). */
export const DEFAULT_KICKOFF_T = 3600;
export const DEFAULT_DRIFT_AMP_RATIO = 0.32; // fraction of capacity added at peak
export const DEFAULT_SIGMA_S = 1200;

/** Egress phase: after the match, the crowd problem inverts — everyone leaves
 *  simultaneously and converges on a few exits/transit nodes, which is usually
 *  the more dangerous crush. The arrival drift bump is centered at kickoff;
 *  the egress boost is a second Gaussian centered after kickoff. Egress phase
 *  starts EGRESS_ONSET_S after kickoff and peaks EGRESS_PEAK_OFFSET_S after. */
export const EGRESS_ONSET_S = 1800; // 30 min after kickoff -> egress begins
export const EGRESS_PEAK_OFFSET_S = 2700; // 45 min after kickoff -> peak egress crush
export const DEFAULT_EGRESS_SIGMA_S = 1200;
export const DEFAULT_EGRESS_AMP_RATIO = 0.4; // fraction of capacity added at egress peak

export type ScenarioPhase = "arrival" | "egress";

/** Which crowd problem are we in? Arrival (fans spreading to seats) vs egress
 *  (fans converging on exits). Pure function of t. */
export function egressPhase(
  t: number,
  kickoffT: number = DEFAULT_KICKOFF_T,
  onset: number = EGRESS_ONSET_S
): ScenarioPhase {
  return t > kickoffT + onset ? "egress" : "arrival";
}

/** Egress crush bump: a Gaussian centered after kickoff that spikes exit-bound
 *  nodes (gates, concourses, exits, transit). Pure function of t. */
export function egressBoost(
  capacity: number,
  t: number,
  kickoffT: number = DEFAULT_KICKOFF_T,
  peakOffset: number = EGRESS_PEAK_OFFSET_S,
  sigma: number = DEFAULT_EGRESS_SIGMA_S,
  ampRatio: number = DEFAULT_EGRESS_AMP_RATIO
): number {
  const peak = kickoffT + peakOffset;
  const d = t - peak;
  return capacity * ampRatio * Math.exp(-(d * d) / (2 * sigma * sigma));
}

export function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

/** Gaussian bump centered at kickoff — rises before, falls after. */
export function kickoffDrift(
  t: number,
  kickoffT: number,
  driftAmp: number,
  sigma: number
): number {
  const d = t - kickoffT;
  return driftAmp * Math.exp(-(d * d) / (2 * sigma * sigma));
}

/** Occupant count at scenario time t for a node with the given params. */
export function occupancyAt(
  params: JitterParams,
  capacity: number,
  t: number,
  opts: { kickoffT?: number; driftAmp?: number; sigma?: number } = {}
): number {
  const kickoffT = opts.kickoffT ?? DEFAULT_KICKOFF_T;
  const sigma = opts.sigma ?? DEFAULT_SIGMA_S;
  const driftAmp = opts.driftAmp ?? capacity * DEFAULT_DRIFT_AMP_RATIO;
  const cyc =
    params.base +
    params.amplitude * Math.sin((2 * Math.PI * t) / params.period + params.phase) +
    kickoffDrift(t, kickoffT, driftAmp, sigma);
  return clamp(cyc, 0, capacity * MAX_RATIO);
}

/** Edge cost multiplier from a node's current load. 1 at empty, ~5 at full. */
export function crowdMultiplier(occupancy: number, capacity: number): number {
  const ratio = clamp(occupancy / capacity, 0, MAX_RATIO);
  return 1 + ratio * ratio * MAX_PENALTY;
}

/** Estimated wait (minutes) to get through a node at its current load. */
export function waitTime(occupancy: number, capacity: number): number {
  const ratio = clamp(occupancy / capacity, 0, MAX_RATIO);
  return ratio * BASE_SERVICE_TIME_MIN;
}

/** occupancy/capacity ratio, clamped to [0, MAX_RATIO]. */
export function capacityPct(occupancy: number, capacity: number): number {
  return clamp(occupancy / capacity, 0, MAX_RATIO);
}

export function isOverCapacity(occupancy: number, capacity: number): boolean {
  return capacityPct(occupancy, capacity) >= OVER_CAPACITY_THRESHOLD;
}
