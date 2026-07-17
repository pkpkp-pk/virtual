// Deterministic pathfinder: Dijkstra over the stadium graph with crowd-weighted
// edges and a hard accessibility filter. No LLM, no Firestore — occupancy is
// injected, so this is fully unit-testable in isolation.
//
// Edge cost = baseDistance(m) * crowdMultiplier(occupancy[to], capacity[to]).
// The crowd penalty is superlinear, so a jammed nearby gate loses to an emptier
// farther one — the core "which route is fastest RIGHT NOW" decision.
//
// When the trip runs from an external entry point through a gate to a section
// (the common case), routes are ranked *per gate*: the winner is the best
// gate-route and the runner-up is the best route via a *different* gate. That
// is exactly the comparison the XAI layer needs — "Gate C is closer but at 91%
// capacity; Gate B is emptier and net faster." For trips already inside the
// venue (origin is a gate), there is no gate choice, so a single shortest path
// is returned with a waypoint-avoidance runner-up.

import type {
  Constraints,
  OccupancyState,
  PathfinderResult,
  RouteResult,
  SegmentDetail,
} from "../types";
import { ADJACENCY, NODE_MAP } from "./stadiumGraph";
import {
  capacityPct,
  crowdMultiplier,
  isOverCapacity,
  waitTime,
} from "./jitter";

interface DijkstraOut {
  cost: number;
  prev: Record<string, string | undefined>;
}

/** Plain Dijkstra (small graph — array-based min extract is plenty fast).
 *  Core that settles the whole reachable component when `stopAt` is undefined,
 *  or stops once `stopAt` is settled (the targeted optimization). */
function dijkstraCore(
  from: string,
  allowed: Set<string>,
  requireAccessible: boolean,
  occupancy: OccupancyState,
  stopAt?: string
): { dist: Record<string, number>; prev: Record<string, string | undefined> } {
  const dist: Record<string, number> = {};
  const prev: Record<string, string | undefined> = {};
  const visited = new Set<string>();
  dist[from] = 0;
  const queue: string[] = [from];

  while (queue.length) {
    let u = queue[0];
    let ui = 0;
    for (let i = 1; i < queue.length; i++) {
      if (dist[queue[i]] < dist[u]) {
        u = queue[i];
        ui = i;
      }
    }
    queue.splice(ui, 1);
    if (visited.has(u)) continue;
    visited.add(u);
    if (stopAt !== undefined && u === stopAt) break;

    for (const e of ADJACENCY[u] ?? []) {
      if (!allowed.has(e.to)) continue;
      if (requireAccessible && !e.accessible) continue;
      if (visited.has(e.to)) continue;
      const toNode = NODE_MAP[e.to];
      const mult = crowdMultiplier(occupancy[e.to] ?? 0, toNode.capacity);
      const stepCost = e.baseDistance * mult;
      const nd = dist[u] + stepCost;
      if (nd < (dist[e.to] ?? Infinity)) {
        dist[e.to] = nd;
        prev[e.to] = u;
        queue.push(e.to);
      }
    }
  }
  return { dist, prev };
}

function dijkstra(
  from: string,
  to: string,
  allowed: Set<string>,
  requireAccessible: boolean,
  occupancy: OccupancyState
): DijkstraOut | null {
  const { dist, prev } = dijkstraCore(from, allowed, requireAccessible, occupancy, to);
  if (dist[to] === undefined) return null;
  return { cost: dist[to], prev };
}

/** Single-source distances to EVERY reachable node (no early stop). Used by the
 *  rendezvous solver to score candidate meeting spots from several starts. */
export function dijkstraAllFrom(
  from: string,
  allowed: Set<string>,
  requireAccessible: boolean,
  occupancy: OccupancyState
): { dist: Record<string, number>; prev: Record<string, string | undefined> } {
  return dijkstraCore(from, allowed, requireAccessible, occupancy, undefined);
}

export function reconstruct(prev: Record<string, string | undefined>, to: string): string[] {
  const path = [to];
  let cur: string | undefined = to;
  while (cur !== undefined && prev[cur] !== undefined) {
    path.unshift(prev[cur]!);
    cur = prev[cur];
  }
  return path;
}

export function buildRoute(path: string[], occupancy: OccupancyState): RouteResult {
  const segments: SegmentDetail[] = [];
  let totalDistance = 0;
  let totalCost = 0;
  let totalWait = 0;
  for (let i = 0; i < path.length - 1; i++) {
    const from = path[i];
    const to = path[i + 1];
    const edge = (ADJACENCY[from] ?? []).find((e) => e.to === to);
    if (!edge) continue;
    const toNode = NODE_MAP[to];
    const occ = occupancy[to] ?? 0;
    const mult = crowdMultiplier(occ, toNode.capacity);
    const edgeCost = edge.baseDistance * mult;
    const wt = waitTime(occ, toNode.capacity);
    segments.push({
      from,
      to,
      baseDistance: edge.baseDistance,
      occupancy: occ,
      capacity: toNode.capacity,
      capacityPct: capacityPct(occ, toNode.capacity),
      crowdMultiplier: mult,
      edgeCost,
      waitTime: wt,
      accessible: edge.accessible,
    });
    totalDistance += edge.baseDistance;
    totalCost += edgeCost;
    totalWait += wt;
  }
  const gateCapacities = path
    .filter((id) => NODE_MAP[id]?.type === "gate")
    .map((id) => {
      const n = NODE_MAP[id];
      const occ = occupancy[id] ?? 0;
      return {
        id,
        label: n.label,
        occupancy: occ,
        capacity: n.capacity,
        capacityPct: capacityPct(occ, n.capacity),
      };
    });
  return {
    path,
    totalDistance: Math.round(totalDistance),
    totalCost: Math.round(totalCost),
    totalWait: Math.round(totalWait * 10) / 10,
    segments,
    gateCapacities,
  };
}

function gateOnPath(path: string[]): string | undefined {
  return path.find((id) => NODE_MAP[id]?.type === "gate");
}

/** Shortest path constrained to pass through gate g: from -> g -> to. */
function routeThroughGate(
  from: string,
  g: string,
  to: string,
  allowed: Set<string>,
  requireAccessible: boolean,
  occupancy: OccupancyState
): { cost: number; path: string[] } | null {
  const a = dijkstra(from, g, allowed, requireAccessible, occupancy);
  if (!a) return null;
  const b = dijkstra(g, to, allowed, requireAccessible, occupancy);
  if (!b) return null;
  const pathFrom = reconstruct(a.prev, g);
  const pathTo = reconstruct(b.prev, to);
  const path = [...pathFrom, ...pathTo.slice(1)];
  return { cost: a.cost + b.cost, path };
}

/** Gates reachable from `from` AND able to reach `to` in the allowed subgraph. */
function reachableGates(
  from: string,
  to: string,
  allowed: Set<string>,
  requireAccessible: boolean,
  occupancy: OccupancyState
): string[] {
  const gates: string[] = [];
  for (const id of allowed) {
    if (NODE_MAP[id]?.type !== "gate") continue;
    const toGate = dijkstra(from, id, allowed, requireAccessible, occupancy);
    if (!toGate) continue;
    const fromGate = dijkstra(id, to, allowed, requireAccessible, occupancy);
    if (fromGate) gates.push(id);
  }
  return gates;
}

export interface FindRouteInput {
  from: string;
  to: string;
  constraints?: Constraints;
  occupancy: OccupancyState;
  closedGates?: string[];
}

export function findRoute(input: FindRouteInput): PathfinderResult {
  const { from, to, constraints, occupancy, closedGates = [] } = input;
  const requireAccessible = !!constraints?.accessible;
  const closed = new Set(closedGates);

  const allowed = new Set<string>();
  for (const id of Object.keys(NODE_MAP)) {
    if (closed.has(id)) continue;
    if (requireAccessible && !NODE_MAP[id].accessible) continue;
    allowed.add(id);
  }

  // Origin/destination availability.
  if (!allowed.has(from) || !allowed.has(to)) {
    if (requireAccessible && !closed.has(to) && !NODE_MAP[to].accessible) {
      const ref = findReferenceRoute(from, to, occupancy, closed);
      return noAccessiblePath(ref, closedGates);
    }
    return noPath(closedGates);
  }

  const rGates = reachableGates(from, to, allowed, requireAccessible, occupancy);

  // Per-gate ranking only when the user is outside the gate ring (entering the
  // venue from the entry plaza or an external transit/exit node). If they're
  // already at/inside a gate, there's no gate choice — a single shortest path.
  const fromOutside =
    NODE_MAP[from].type === "entry" || NODE_MAP[from].type === "transit";
  if (fromOutside && rGates.length >= 2) {
    return rankGateRoutes(from, to, rGates, allowed, requireAccessible, occupancy, closedGates);
  }

  // Single (or no) gate on the route — standard shortest path.
  const win = dijkstra(from, to, allowed, requireAccessible, occupancy);
  if (!win) {
    if (requireAccessible) {
      const ref = findReferenceRoute(from, to, occupancy, closed);
      return noAccessiblePath(ref, closedGates);
    }
    return noPath(closedGates);
  }
  const winnerPath = reconstruct(win.prev, to);
  const winner = buildRoute(winnerPath, occupancy);

  // Runner-up: avoid the winner's gate, else its first waypoint.
  const altAllowed = new Set(allowed);
  const block = gateOnPath(winnerPath) ?? winnerPath[1];
  if (block) altAllowed.delete(block);
  const alt = altAllowed.has(to)
    ? dijkstra(from, to, altAllowed, requireAccessible, occupancy)
    : null;
  const runnerUp = alt ? buildRoute(reconstruct(alt.prev, to), occupancy) : null;

  const overCapacityGates = collectOverCapacity(rGates, occupancy);
  const allOverCapacity =
    rGates.length > 0 && overCapacityGates.length === rGates.length;

  return {
    status: allOverCapacity ? "all_over_capacity" : "ok",
    winner,
    runnerUp,
    reasonData: buildReason(winner, runnerUp, gateOnPath(winnerPath), runnerUp ? gateOnPath(runnerUp.path) : undefined, overCapacityGates),
    closedGates,
  };
}

/** Per-gate ranking: winner = best gate-route, runner-up = best via a different gate. */
function rankGateRoutes(
  from: string,
  to: string,
  rGates: string[],
  allowed: Set<string>,
  requireAccessible: boolean,
  occupancy: OccupancyState,
  closedGates: string[]
): PathfinderResult {
  const candidates = rGates
    .map((g) => {
      const r = routeThroughGate(from, g, to, allowed, requireAccessible, occupancy);
      return r ? { gate: g, cost: r.cost, path: r.path } : null;
    })
    .filter((c): c is { gate: string; cost: number; path: string[] } => c !== null)
    .sort((a, b) => a.cost - b.cost);

  if (candidates.length === 0) {
    // reachableGates said routes exist but per-gate build failed — fall back.
    return noPath(closedGates);
  }

  // Build every candidate route once so we can surface the full gate ranking
  // (not just winner/runner-up) for richer XAI.
  const built = candidates.map((c) => ({
    gate: c.gate,
    route: buildRoute(c.path, occupancy),
  }));
  const winner = built[0].route;
  const runnerUp = built.length >= 2 ? built[1].route : null;

  const allGates = built.map((b) => {
    const n = NODE_MAP[b.gate];
    const occ = occupancy[b.gate] ?? 0;
    return {
      gate: b.gate,
      label: n.label,
      totalCost: b.route.totalCost,
      totalWait: b.route.totalWait,
      capacityPct: capacityPct(occ, n.capacity),
    };
  });

  const overCapacityGates = collectOverCapacity(rGates, occupancy);
  const allOverCapacity = overCapacityGates.length === rGates.length;

  return {
    status: allOverCapacity ? "all_over_capacity" : "ok",
    winner,
    runnerUp,
    reasonData: buildReason(
      winner,
      runnerUp,
      candidates[0].gate,
      candidates[1]?.gate,
      overCapacityGates
    ),
    allGates,
    closedGates,
  };
}

function findReferenceRoute(
  from: string,
  to: string,
  occupancy: OccupancyState,
  closed: Set<string>
): RouteResult | null {
  const fullAllowed = new Set<string>();
  for (const id of Object.keys(NODE_MAP)) {
    if (closed.has(id)) continue;
    fullAllowed.add(id);
  }
  if (!fullAllowed.has(from) || !fullAllowed.has(to)) return null;
  const r = dijkstra(from, to, fullAllowed, false, occupancy);
  if (!r) return null;
  return buildRoute(reconstruct(r.prev, to), occupancy);
}

function collectOverCapacity(rGates: string[], occupancy: OccupancyState) {
  return rGates
    .map((id) => {
      const n = NODE_MAP[id];
      const occ = occupancy[id] ?? 0;
      return {
        id,
        label: n.label,
        occupancy: occ,
        capacity: n.capacity,
        capacityPct: capacityPct(occ, n.capacity),
      };
    })
    .filter((g) => isOverCapacity(g.occupancy, g.capacity));
}

function buildReason(
  winner: RouteResult,
  runnerUp: RouteResult | null,
  winnerGate: string | undefined,
  runnerUpGate: string | undefined,
  overCapacityGates: ReturnType<typeof collectOverCapacity>
) {
  return {
    distanceDelta: runnerUp ? winner.totalDistance - runnerUp.totalDistance : 0,
    costDelta: runnerUp ? winner.totalCost - runnerUp.totalCost : 0,
    waitDelta: runnerUp
      ? Math.round((winner.totalWait - runnerUp.totalWait) * 10) / 10
      : 0,
    winnerGate,
    runnerUpGate,
    overCapacityGates,
  };
}

function noAccessiblePath(referenceRoute: RouteResult | null, closedGates: string[]): PathfinderResult {
  return {
    status: "no_accessible_path",
    winner: null,
    runnerUp: null,
    reasonData: { distanceDelta: 0, costDelta: 0, waitDelta: 0, overCapacityGates: [] },
    referenceRoute,
    closedGates,
  };
}

function noPath(closedGates: string[]): PathfinderResult {
  return {
    status: "no_path",
    winner: null,
    runnerUp: null,
    reasonData: { distanceDelta: 0, costDelta: 0, waitDelta: 0, overCapacityGates: [] },
    closedGates,
  };
}
