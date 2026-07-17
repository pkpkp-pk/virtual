// Group rendezvous solver — "my friends and I got split up, where do we meet
// that isn't a crowd crush?"
//
// Given two or more starting nodes, run the same Dijkstra from each start
// (single-source, all nodes) and score every candidate meeting spot (amenities
// + concourse junctions) by COMBINED travel cost from all starts, penalized by
// the spot's current crowd load. The best rendezvous is the one that's cheap
// for everyone to reach AND not currently jammed.
//
// This is a new entry point into the existing pathfinder — no new
// infrastructure. Fully deterministic and unit-testable in isolation.

import { NODE_MAP, nodeLabel } from "./stadiumGraph";
import { dijkstraAllFrom, reconstruct, buildRoute } from "./pathfinder";
import { crowdMultiplier, capacityPct } from "./jitter";
import type { Constraints, OccupancyState, RouteResult } from "../types";

/** Node types that make sense as a meeting spot (not gates/sections/exits). */
const MEETING_TYPES = new Set(["amenity", "concourse"]);

export interface RendezvousPersonRoute {
  startId: string;
  startLabel: string;
  path: string[];
  totalDistance: number;
  totalWait: number;
}

export interface RendezvousCandidate {
  nodeId: string;
  label: string;
  /** Sum of each person's travel cost to reach this spot. */
  combinedCost: number;
  /** Current load at the meeting spot (0..1.2). */
  capacityPct: number;
  /** Crowd multiplier at the spot — penalizes jammed meeting points. */
  crowdMultiplier: number;
  /** combinedCost * crowdMultiplier — the ranking score (lower is better). */
  score: number;
  routes: RendezvousPersonRoute[];
}

export interface RendezvousResult {
  status: "ok" | "no_path";
  suggestions: RendezvousCandidate[];
  closedGates: string[];
}

export interface FindRendezvousInput {
  starts: string[];
  constraints?: Constraints;
  occupancy: OccupancyState;
  closedGates?: string[];
}

export function findRendezvous(input: FindRendezvousInput): RendezvousResult {
  const { starts, constraints, occupancy, closedGates = [] } = input;
  const requireAccessible = !!constraints?.accessible;
  const closed = new Set(closedGates);

  const allowed = new Set<string>();
  for (const id of Object.keys(NODE_MAP)) {
    if (closed.has(id)) continue;
    if (requireAccessible && !NODE_MAP[id].accessible) continue;
    allowed.add(id);
  }

  const validStarts = starts.filter((s) => allowed.has(s));
  if (validStarts.length < 2) {
    return { status: "no_path", suggestions: [], closedGates };
  }

  // Single-source distances from each start to every reachable node.
  const dists = validStarts.map((s) => ({
    start: s,
    ...dijkstraAllFrom(s, allowed, requireAccessible, occupancy),
  }));

  const candidates: RendezvousCandidate[] = [];
  for (const id of allowed) {
    if (!MEETING_TYPES.has(NODE_MAP[id].type)) continue;
    // Every start must be able to reach the candidate.
    let combinedCost = 0;
    let reachable = true;
    for (const d of dists) {
      const c = d.dist[id];
      if (c === undefined) {
        reachable = false;
        break;
      }
      combinedCost += c;
    }
    if (!reachable) continue;

    const cap = NODE_MAP[id].capacity;
    const occ = occupancy[id] ?? 0;
    const mult = crowdMultiplier(occ, cap);
    const pct = capacityPct(occ, cap);
    const routes: RendezvousPersonRoute[] = dists.map((d) => {
      const path = reconstruct(d.prev, id);
      const r: RouteResult = buildRoute(path, occupancy);
      return {
        startId: d.start,
        startLabel: nodeLabel(d.start),
        path: r.path,
        totalDistance: r.totalDistance,
        totalWait: r.totalWait,
      };
    });
    candidates.push({
      nodeId: id,
      label: nodeLabel(id),
      combinedCost: Math.round(combinedCost),
      capacityPct: pct,
      crowdMultiplier: mult,
      score: combinedCost * mult,
      routes,
    });
  }

  candidates.sort((a, b) => a.score - b.score);
  return {
    status: candidates.length > 0 ? "ok" : "no_path",
    suggestions: candidates.slice(0, 3),
    closedGates,
  };
}

/** Compact, model-friendly serialization — the numbers the LLM cites. */
export function serializeRendezvous(res: RendezvousResult): Record<string, unknown> {
  return {
    status: res.status,
    suggestions: res.suggestions.map((c) => ({
      meetingSpot: c.label,
      nodeId: c.nodeId,
      combinedTravelCost: c.combinedCost,
      currentLoad: Math.round(c.capacityPct * 100) + "%",
      crowdPenaltyMultiplier: Math.round(c.crowdMultiplier * 100) / 100,
      score: Math.round(c.score),
      routes: c.routes.map((r) => ({
        from: r.startLabel,
        path: r.path.map(nodeLabel).join(" → "),
        walkingMeters: r.totalDistance,
        waitMinutes: r.totalWait,
      })),
    })),
    closedGates: res.closedGates.map(nodeLabel),
  };
}
