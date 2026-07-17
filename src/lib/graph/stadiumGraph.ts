// Coarse graph model of MetLife Stadium (East Rutherford, NJ).
// Center ~ 40.8128 N, 74.0742 W. Coordinates are approximate real-world points
// around the venue — enough nodes for routing to be meaningfully more than
// "gate A vs gate B": 5 gates, 5 concourse junctions, 6 sections, 4 amenities,
// 1 external entry plaza (~21 nodes).
//
// The graph itself is static (the *map* doesn't move). Live state lives in the
// occupancy map derived from jitter(t), not here.

import type { GraphEdge, GraphNode, JitterParams, OccupancyState } from "../types";
import { occupancyAt, egressPhase, egressBoost, clamp, MAX_RATIO } from "./jitter";

/** Great-circle distance between two lat/lng points, in meters. */
export function haversineMeters(
  aLat: number,
  aLng: number,
  bLat: number,
  bLng: number
): number {
  const R = 6371000; // Earth radius (m)
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const lat1 = toRad(aLat);
  const lat2 = toRad(bLat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

interface NodeSeed {
  id: string;
  type: GraphNode["type"];
  lat: number;
  lng: number;
  capacity: number;
  accessible: boolean;
  label: string;
  jitter: JitterParams;
}

// Per-node jitter params: baseline ~60% capacity, amplitude ~18% capacity,
// periods vary (180–300s) so nodes don't oscillate in lockstep — liveliness.
function jp(baseRatio: number, ampRatio: number, period: number, phase: number) {
  return (capacity: number): JitterParams => ({
    base: capacity * baseRatio,
    amplitude: capacity * ampRatio,
    period,
    phase,
  });
}

const NODES: NodeSeed[] = [
  // External entry plaza (south of the stadium). Connected to every gate so the
  // pathfinder can choose which gate to enter — the core "which route" decision.
  {
    id: "entry_plaza",
    type: "entry",
    lat: 40.8105,
    lng: -74.0742,
    capacity: 20000,
    accessible: true,
    label: "Entry Plaza",
    jitter: { base: 3000, amplitude: 800, period: 240, phase: 0 },
  },
  // Gates around the perimeter.
  { id: "gate_a", type: "gate", lat: 40.8128, lng: -74.076, capacity: 6000, accessible: true, label: "Gate A (West)", jitter: jp(0.55, 0.2, 220, 0.4)(6000) },
  { id: "gate_b", type: "gate", lat: 40.8112, lng: -74.0742, capacity: 6000, accessible: true, label: "Gate B (South)", jitter: jp(0.7, 0.16, 200, 1.1)(6000) },
  { id: "gate_c", type: "gate", lat: 40.8128, lng: -74.0724, capacity: 6000, accessible: true, label: "Gate C (East)", jitter: jp(0.85, 0.12, 180, 2.3)(6000) },
  { id: "gate_d", type: "gate", lat: 40.8146, lng: -74.0742, capacity: 6000, accessible: true, label: "Gate D (North)", jitter: jp(0.5, 0.18, 260, 3.0)(6000) },
  { id: "gate_vip", type: "gate", lat: 40.8142, lng: -74.0758, capacity: 2000, accessible: true, label: "VIP Gate (NW)", jitter: jp(0.4, 0.15, 300, 4.2)(2000) },
  // Concourse junctions (ring + center).
  { id: "junction_n", type: "concourse", lat: 40.8138, lng: -74.0742, capacity: 4000, accessible: true, label: "North Concourse", jitter: jp(0.5, 0.14, 230, 0.7)(4000) },
  { id: "junction_s", type: "concourse", lat: 40.8118, lng: -74.0742, capacity: 4000, accessible: true, label: "South Concourse", jitter: jp(0.6, 0.15, 210, 1.9)(4000) },
  { id: "junction_e", type: "concourse", lat: 40.8128, lng: -74.0732, capacity: 4000, accessible: true, label: "East Concourse", jitter: jp(0.55, 0.13, 250, 2.6)(4000) },
  { id: "junction_w", type: "concourse", lat: 40.8128, lng: -74.0752, capacity: 4000, accessible: true, label: "West Concourse", jitter: jp(0.5, 0.14, 240, 3.4)(4000) },
  { id: "junction_c", type: "concourse", lat: 40.8128, lng: -74.0742, capacity: 5000, accessible: true, label: "Central Concourse", jitter: jp(0.62, 0.16, 200, 5.1)(5000) },
  // Sections. sec_300 and sec_field are stair-only (accessible=false edges) to
  // demo the "no accessible path" edge case.
  { id: "sec_125", type: "section", lat: 40.8135, lng: -74.075, capacity: 1200, accessible: true, label: "Section 125", jitter: jp(0.45, 0.1, 280, 0.3)(1200) },
  { id: "sec_126", type: "section", lat: 40.8135, lng: -74.0734, capacity: 1200, accessible: true, label: "Section 126", jitter: jp(0.5, 0.1, 270, 1.5)(1200) },
  { id: "sec_club_w", type: "section", lat: 40.8128, lng: -74.0748, capacity: 1000, accessible: true, label: "Club West", jitter: jp(0.55, 0.12, 260, 2.1)(1000) },
  { id: "sec_club_e", type: "section", lat: 40.8128, lng: -74.0736, capacity: 1000, accessible: true, label: "Club East", jitter: jp(0.6, 0.11, 250, 2.9)(1000) },
  { id: "sec_300", type: "section", lat: 40.8122, lng: -74.0742, capacity: 1500, accessible: false, label: "Section 300 (Upper)", jitter: jp(0.4, 0.1, 300, 4.0)(1500) },
  { id: "sec_field", type: "section", lat: 40.812, lng: -74.0745, capacity: 800, accessible: false, label: "Field Level", jitter: jp(0.35, 0.12, 310, 4.8)(800) },
  // Amenities.
  { id: "amen_restroom_n", type: "amenity", lat: 40.8137, lng: -74.0742, capacity: 250, accessible: true, label: "Restrooms (N)", jitter: jp(0.5, 0.2, 180, 0.9)(250) },
  { id: "amen_concession_e", type: "amenity", lat: 40.8128, lng: -74.073, capacity: 300, accessible: true, label: "Concessions (E)", jitter: jp(0.55, 0.18, 190, 2.2)(300) },
  { id: "amen_restroom_s", type: "amenity", lat: 40.8119, lng: -74.0742, capacity: 250, accessible: true, label: "Restrooms (S)", jitter: jp(0.45, 0.2, 200, 3.6)(250) },
  { id: "amen_firstaid_w", type: "amenity", lat: 40.8128, lng: -74.0754, capacity: 150, accessible: true, label: "First Aid (W)", jitter: jp(0.3, 0.1, 240, 5.5)(150) },
  // External transit / exit nodes. These are the egress destinations ("fastest
  // way out to NJ Transit") and extend routing beyond the venue perimeter — a
  // light touch on the transportation vertical. They sit largely empty during
  // arrival and jam during the egress crush (see nodeOccupancyAt).
  { id: "nj_transit", type: "transit", lat: 40.8155, lng: -74.07, capacity: 8000, accessible: true, label: "NJ Transit", jitter: jp(0.08, 0.04, 300, 0.2)(8000) },
  { id: "parking_east", type: "transit", lat: 40.815, lng: -74.0725, capacity: 10000, accessible: true, label: "Parking East", jitter: jp(0.1, 0.05, 320, 1.4)(10000) },
  { id: "rideshare_dropoff", type: "transit", lat: 40.81, lng: -74.0765, capacity: 3000, accessible: true, label: "Rideshare Drop-off", jitter: jp(0.06, 0.03, 280, 3.3)(3000) },
];

// Undirected edge seeds: [from, to, accessible]. baseDistance is computed from
// the endpoint coordinates so distances are real and consistent.
const EDGE_SEEDS: Array<[string, string, boolean]> = [
  // Entry plaza -> every gate (the gate-choice decision).
  ["entry_plaza", "gate_a", true],
  ["entry_plaza", "gate_b", true],
  ["entry_plaza", "gate_c", true],
  ["entry_plaza", "gate_d", true],
  ["entry_plaza", "gate_vip", true],
  // Gates -> nearest concourse junction.
  ["gate_a", "junction_w", true],
  ["gate_b", "junction_s", true],
  ["gate_c", "junction_e", true],
  ["gate_d", "junction_n", true],
  ["gate_vip", "junction_w", false], // VIP stairs down to concourse (not accessible)
  ["gate_vip", "junction_n", true], // VIP elevator to north concourse (accessible alt)
  // Concourse ring + spokes to center.
  ["junction_n", "junction_c", true],
  ["junction_s", "junction_c", true],
  ["junction_e", "junction_c", true],
  ["junction_w", "junction_c", true],
  ["junction_n", "junction_e", true],
  ["junction_e", "junction_s", true],
  ["junction_s", "junction_w", true],
  ["junction_w", "junction_n", true],
  // Sections from their nearest junction.
  ["junction_n", "sec_125", true],
  ["junction_n", "sec_126", true],
  ["junction_w", "sec_club_w", true],
  ["junction_e", "sec_club_e", true],
  ["junction_s", "sec_300", false], // upper-bowl stairs (not accessible)
  ["junction_s", "sec_field", false], // field-level stairs (not accessible)
  // Amenities from their nearest junction.
  ["junction_n", "amen_restroom_n", true],
  ["junction_e", "amen_concession_e", true],
  ["junction_s", "amen_restroom_s", true],
  ["junction_w", "amen_firstaid_w", true],
  // External exits -> entry plaza (the egress destinations).
  ["entry_plaza", "nj_transit", true],
  ["entry_plaza", "parking_east", true],
  ["entry_plaza", "rideshare_dropoff", true],
];

export const NODE_LIST: GraphNode[] = NODES.map((n) => ({
  id: n.id,
  type: n.type,
  lat: n.lat,
  lng: n.lng,
  capacity: n.capacity,
  accessible: n.accessible,
  label: n.label,
}));

export const NODE_MAP: Record<string, GraphNode> = Object.fromEntries(
  NODE_LIST.map((n) => [n.id, n])
);

export const JITTER_MAP: Record<string, JitterParams> = Object.fromEntries(
  NODES.map((n) => [n.id, n.jitter])
);

function coord(id: string): { lat: number; lng: number } {
  const n = NODE_MAP[id];
  if (!n) throw new Error(`unknown node ${id}`);
  return { lat: n.lat, lng: n.lng };
}

/** Bidirectional edge list with haversine baseDistance. */
export const EDGE_LIST: GraphEdge[] = EDGE_SEEDS.flatMap(([from, to, accessible]) => {
  const a = coord(from);
  const b = coord(to);
  const baseDistance = Math.round(haversineMeters(a.lat, a.lng, b.lat, b.lng));
  return [
    { from, to, baseDistance, accessible },
    { from: to, to: from, baseDistance, accessible },
  ];
});

/** Adjacency list: nodeId -> outbound edges. */
export const ADJACENCY: Record<string, GraphEdge[]> = EDGE_LIST.reduce(
  (acc, e) => {
    (acc[e.from] ??= []).push(e);
    return acc;
  },
  {} as Record<string, GraphEdge[]>
);

export const GRAPH = {
  nodes: NODE_LIST,
  edges: EDGE_LIST,
  nodeMap: NODE_MAP,
  adjacency: ADJACENCY,
  jitterMap: JITTER_MAP,
};

/** Occupancy for a single node at scenario time t, applying the crowd PHASE.
 *
 *  Arrival phase: the raw jitter model (fans spreading to seats; gates jammed
 *  near kickoff). Egress phase (t > kickoff + onset): the problem inverts —
 *  sections depopulate as fans head out, while gates, concourses, exits, and
 *  transit nodes take an egress-crush boost on top of their arrival load.
 *
 *  Pure function of t, so the egress dynamics are as computable/testable as the
 *  arrival ones — the map keeps evolving on its own with no writer. */
export function nodeOccupancyAt(nodeId: string, t: number): number {
  const node = NODE_MAP[nodeId];
  const params = JITTER_MAP[nodeId];
  if (!node || !params) return 0;
  const base = occupancyAt(params, node.capacity, t);
  if (egressPhase(t) === "egress") {
    if (node.type === "section") {
      // Fans have left their seats for the exits.
      return Math.round(clamp(base * 0.3, 0, node.capacity * MAX_RATIO));
    }
    if (
      node.type === "gate" ||
      node.type === "concourse" ||
      node.type === "entry" ||
      node.type === "transit"
    ) {
      // Exit crush: the egress boost piles on top of the arrival load.
      return Math.round(
        clamp(base + egressBoost(node.capacity, t), 0, node.capacity * MAX_RATIO)
      );
    }
    // Amenities keep the arrival model.
  }
  return Math.round(base);
}

/** Deterministic occupancy map for the whole graph at scenario time t. */
export function occupancyAtTime(t: number): OccupancyState {
  const state: OccupancyState = {};
  for (const n of NODES) {
    state[n.id] = nodeOccupancyAt(n.id, t);
  }
  return state;
}

export function nodeLabel(id: string): string {
  return NODE_MAP[id]?.label ?? id;
}
