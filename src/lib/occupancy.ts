// Occupancy provider: the live crowd state the pathfinder consumes.
//
// Occupancy is ALWAYS computed from the pure jitter(t) model — never read from
// Firestore. Firestore would only echo what jitter already computes (circular),
// so we don't persist occupancy. Firestore carries the genuinely-shared state
// (gate closures, events) instead; here we read just the closed-gate set when
// configured, and fall back to in-memory dev state otherwise.
//
// Because jitter(t) is a pure function of wall-clock time, the state STILL
// genuinely evolves on its own with no user interaction and no scheduler — the
// demo is non-static even before Firebase is wired.

import { occupancyAtTime } from "./graph/stadiumGraph";
import { egressPhase, type ScenarioPhase } from "./graph/jitter";
import { firebaseConfigured, readClosedGates } from "./firebase/admin";
import { getDevClosedGates } from "./sim/state";
import type { OccupancyState } from "./types";

/** Scenario clock: seconds since the scenario epoch. The epoch defaults to
 *  50 minutes before process start so a demo session opens ~10 min before
 *  kickoff and watches the surge build. Override via SCENARIO_EPOCH_MS. */
const SCENARIO_EPOCH_MS =
  Number(process.env.SCENARIO_EPOCH_MS) || Date.now() - 3000_000;

export function scenarioTime(): number {
  return (Date.now() - SCENARIO_EPOCH_MS) / 1000;
}

export interface OccupancySnapshot {
  state: OccupancyState;
  closedGates: string[];
  source: "jitter";
  t: number; // scenario time the snapshot reflects
  phase: ScenarioPhase;
}

export async function getOccupancy(): Promise<OccupancySnapshot> {
  const t = scenarioTime();
  const state = occupancyAtTime(t);
  let closedGates: string[];
  if (firebaseConfigured()) {
    try {
      closedGates = await readClosedGates();
    } catch (err) {
      // Don't break routing if Firestore is unreachable.
      console.warn("[occupancy] closed-gate read failed, using dev state:", err);
      closedGates = getDevClosedGates();
    }
  } else {
    closedGates = getDevClosedGates();
  }
  return { state, closedGates, source: "jitter", t, phase: egressPhase(t) };
}
