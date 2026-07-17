// Pure event-detection logic for the live alert system.
//
// The crowd route polls every few seconds; on a throttled cadence it compares the
// current per-gate load (computed from jitter(t)) to the last-seen gate state and
// emits "events" — gate threshold crossings and arrival↔egress phase flips. These
// events are written to Firestore (`events` collection) and pushed via FCM so every
// fan sees the same alert at the same time.
//
// Everything here is pure (no Firestore, no FCM, no Date.now) so it unit-tests in
// isolation. `now` is passed in by the caller.

import { NODE_MAP } from "./graph/stadiumGraph";
import {
  OVER_CAPACITY_THRESHOLD,
  capacityPct,
  type ScenarioPhase,
} from "./graph/jitter";
import type { OccupancyState } from "./types";

export interface GateStatus {
  over: boolean;
  pct: number; // 0..1.2
}

/** Per-gate over/under status for the whole gate ring, derived from an occupancy map. */
export type GateStatusMap = Record<string, GateStatus>;

export interface GateStateDoc {
  gates: GateStatusMap;
  phase: ScenarioPhase;
  updatedAt: number;
}

export type CrowdEventType = "gate_crossing" | "phase_change";

export interface CrowdEvent {
  type: CrowdEventType;
  gateId?: string;
  gateLabel?: string;
  phase?: ScenarioPhase;
  pct?: number;
  at: number; // epoch ms (passed in by the caller)
  message: string;
}

/** Compute each gate's {over, pct} from an occupancy map. Pure. */
export function computeGateStatuses(
  state: OccupancyState,
  threshold: number = OVER_CAPACITY_THRESHOLD
): GateStatusMap {
  const out: GateStatusMap = {};
  for (const id of Object.keys(NODE_MAP)) {
    if (NODE_MAP[id].type !== "gate") continue;
    const cap = NODE_MAP[id].capacity;
    const occ = state[id] ?? 0;
    const pct = capacityPct(occ, cap);
    out[id] = { over: pct >= threshold, pct };
  }
  return out;
}

/** Compare previous gate state to current and return the new events to emit.
 *  - Upward gate crossing (was under, now over) → a gate_crossing event.
 *  - Phase flip (arrival↔egress) → a phase_change event.
 *  Downward crossings and no-change produce no events (we nudge on the way IN to
 *  a jam, not on the way out). Pure. */
export function detectCrossings(
  prev: GateStateDoc | null,
  currentGates: GateStatusMap,
  currentPhase: ScenarioPhase,
  now: number
): CrowdEvent[] {
  const events: CrowdEvent[] = [];

  // No baseline (first poll after a cold start) → nothing to compare, so emit
  // nothing. The baseline is written this cycle; real transitions are detected
  // on subsequent polls. This also avoids a cold-start burst of FCM pushes for
  // every gate that happens to be jammed at startup.
  if (!prev) return [];

  for (const [id, cur] of Object.entries(currentGates)) {
    const wasOver = prev.gates[id]?.over ?? false;
    if (!wasOver && cur.over) {
      const label = NODE_MAP[id]?.label ?? id;
      events.push({
        type: "gate_crossing",
        gateId: id,
        gateLabel: label,
        pct: cur.pct,
        at: now,
        message: `${label} just crossed ${Math.round(cur.pct * 100)}% capacity — expect delays.`,
      });
    }
  }

  if (prev.phase !== currentPhase) {
    events.push({
      type: "phase_change",
      phase: currentPhase,
      at: now,
      message:
        currentPhase === "egress"
          ? "Match traffic is shifting to egress — exits and transit are getting crowded. Plan your way out."
          : "Traffic is shifting back to arrival patterns.",
    });
  }

  return events;
}

export { OVER_CAPACITY_THRESHOLD };
