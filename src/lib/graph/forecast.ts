// Deterministic crowd forecasting.
//
// occupancyAt(params, capacity, t) is a PURE function of time, so the future is
// as computable as the present: sample it at t + Δ to project a node's load
// forward. This is what turns a snapshot recommendation into real-time decision
// support — "wait 4 min, Gate C drops 91%→68%" — with zero new infrastructure.
//
// Like the rest of the graph layer, this is deterministic and unit-testable in
// isolation (no LLM, no Firestore). When the live source is Firestore, the
// forecast projects the jitter model forward from the current scenario time —
// the model is the dynamics; the Firestore snapshot is just an observation.

import { NODE_MAP, nodeLabel, nodeOccupancyAt } from "./stadiumGraph";
import { capacityPct, isOverCapacity, OVER_CAPACITY_THRESHOLD } from "./jitter";
import type { RouteResult } from "../types";

/** A node counts as "calm enough" once it drops below this load. */
export const CALM_THRESHOLD = 0.7;

export interface ForecastPoint {
  deltaMin: number;
  occupancy: number;
  capacityPct: number; // 0..1.2
}

export interface NodeForecast {
  nodeId: string;
  label: string;
  now: { occupancy: number; capacityPct: number };
  overCapacityNow: boolean;
  projections: ForecastPoint[];
  /** Minutes from now until the node first drops below CALM_THRESHOLD, if it is
   *  currently over capacity. undefined if not jammed now or it never clears
   *  within the horizon. */
  clearsBelowThresholdAtMin?: number;
}

/** Project a single node's load forward from scenario time `fromT`, using the
 *  same phase-aware model as the live snapshot (nodeOccupancyAt) so the "now"
 *  value always matches what the map shows — including during egress. */
export function forecastNode(
  nodeId: string,
  fromT: number,
  horizonMin = 15,
  stepMin = 1,
  calmThreshold: number = CALM_THRESHOLD
): NodeForecast {
  const node = NODE_MAP[nodeId];
  if (!node) {
    return {
      nodeId,
      label: nodeLabel(nodeId),
      now: { occupancy: 0, capacityPct: 0 },
      overCapacityNow: false,
      projections: [],
    };
  }
  const cap = node.capacity;
  const nowOcc = nodeOccupancyAt(nodeId, fromT);
  const nowPct = capacityPct(nowOcc, cap);
  const projections: ForecastPoint[] = [];
  let clearsBelowThresholdAtMin: number | undefined;
  const overNow = isOverCapacity(nowOcc, cap);
  for (let delta = stepMin; delta <= horizonMin; delta += stepMin) {
    const occ = nodeOccupancyAt(nodeId, fromT + delta * 60);
    const pct = capacityPct(occ, cap);
    projections.push({ deltaMin: delta, occupancy: occ, capacityPct: pct });
    if (
      overNow &&
      clearsBelowThresholdAtMin === undefined &&
      pct < calmThreshold
    ) {
      clearsBelowThresholdAtMin = delta;
    }
  }
  return {
    nodeId,
    label: node.label,
    now: { occupancy: nowOcc, capacityPct: nowPct },
    overCapacityNow: overNow,
    projections,
    clearsBelowThresholdAtMin,
  };
}

export interface GateWaitRecommendation {
  gateId: string;
  gateLabel: string;
  nowPct: number; // 0..1
  clearsAtMin?: number;
  /** Plain-language recommendation citing the real projected figures. */
  message: string;
}

/** When the winner route goes through a jammed gate, recommend whether to wait
 *  (and for how long) using the forecast. Returns null if the winner gate isn't
 *  jammed — nothing to recommend. */
export function gateWaitRecommendation(
  winner: RouteResult,
  fromT: number,
  calmThreshold: number = CALM_THRESHOLD
): GateWaitRecommendation | null {
  const gate = winner.gateCapacities[0];
  if (!gate) return null;
  if (!isOverCapacity(gate.occupancy, gate.capacity)) return null;
  const fc = forecastNode(gate.id, fromT, 20, 1, calmThreshold);
  const nowPct = Math.round(fc.now.capacityPct * 100);
  if (fc.clearsBelowThresholdAtMin !== undefined) {
    const clearPct = Math.round(
      (fc.projections.find((p) => p.deltaMin === fc.clearsBelowThresholdAtMin)
        ?.capacityPct ?? calmThreshold) * 100
    );
    return {
      gateId: gate.id,
      gateLabel: gate.label,
      nowPct: fc.now.capacityPct,
      clearsAtMin: fc.clearsBelowThresholdAtMin,
      message: `${gate.label} is at ${nowPct}% now but is forecast to drop below ${Math.round(
        calmThreshold * 100
      )}% (~${clearPct}%) in about ${fc.clearsBelowThresholdAtMin} min — if you can wait, it gets better.`,
    };
  }
  return {
    gateId: gate.id,
    gateLabel: gate.label,
    nowPct: fc.now.capacityPct,
    message: `${gate.label} is at ${nowPct}% and is NOT forecast to clear within 20 min — this is the least-bad option right now.`,
  };
}

/** Compact, model-friendly serialization of a forecast — the numbers the LLM
 *  cites verbatim in its "wait N min" recommendation. */
export function serializeForecast(fc: NodeForecast): Record<string, unknown> {
  return {
    node: fc.label,
    nodeId: fc.nodeId,
    nowCapacityPct: Math.round(fc.now.capacityPct * 100) + "%",
    overCapacityNow: fc.overCapacityNow,
    forecast: fc.projections.map((p) => ({
      inMinutes: p.deltaMin,
      capacityPct: Math.round(p.capacityPct * 100) + "%",
    })),
    clearsBelowThresholdInMin: fc.clearsBelowThresholdAtMin ?? null,
    calmThresholdPct: Math.round(CALM_THRESHOLD * 100) + "%",
  };
}

export { OVER_CAPACITY_THRESHOLD };
