// Core domain types for the stadium navigator.
// These are shared by the deterministic pathfinder, the crowd simulation,
// and the Gemini tool-use layer. No LLM or Firestore coupling here — the
// pathfinder consumes plain maps so it stays unit-testable in isolation.

export type NodeType =
  | "gate"
  | "concourse"
  | "amenity"
  | "section"
  | "entry"
  | "transit";

export interface GraphNode {
  id: string;
  type: NodeType;
  /** Real-world latitude/longitude (MetLife Stadium, geocoded). */
  lat: number;
  lng: number;
  /** Max occupants the node can hold/throughput. */
  capacity: number;
  /** Wheelchair-reachable node. */
  accessible: boolean;
  /** Human-readable label, e.g. "MetLife Gate C". */
  label: string;
}

export interface GraphEdge {
  from: string;
  to: string;
  /** Walking distance in meters (haversine of the endpoint coords). */
  baseDistance: number;
  /** True if the segment is ramp/elevator (wheelchair usable); false = stairs. */
  accessible: boolean;
}

/** Map of nodeId -> current occupant count. Injected into the pathfinder. */
export type OccupancyState = Record<string, number>;

/** Per-node parameters for the deterministic time-based jitter function. */
export interface JitterParams {
  base: number; // baseline occupancy (absolute count)
  amplitude: number; // sinusoidal oscillation amplitude (absolute count)
  period: number; // seconds for one full oscillation cycle
  phase: number; // phase offset in radians
}

export interface Constraints {
  /** If true, restrict routing to accessible nodes/edges only. */
  accessible?: boolean;
  /** Preferred explanation language (BCP-47 tag or free-form, e.g. "es", "Spanish"). */
  language?: string;
}

export type RouteStatus =
  | "ok"
  | "all_over_capacity"
  | "no_accessible_path"
  | "no_path";

export interface SegmentDetail {
  from: string;
  to: string;
  baseDistance: number; // meters
  occupancy: number; // occupants at the arriving ("to") node
  capacity: number;
  capacityPct: number; // occupancy / capacity (0..1.2)
  crowdMultiplier: number; // edge cost multiplier applied
  edgeCost: number; // baseDistance * crowdMultiplier (the optimization objective unit)
  waitTime: number; // estimated minutes waiting at the "to" node
  accessible: boolean;
}

export interface GateCapacity {
  id: string;
  label: string;
  occupancy: number;
  capacity: number;
  capacityPct: number;
}

/** One gate's ranking in a per-gate route comparison (richer XAI: surface the
 *  gates the pathfinder considered but didn't pick, not just winner/runner-up). */
export interface GateRanking {
  gate: string;
  label: string;
  totalCost: number;
  totalWait: number;
  capacityPct: number;
}

export interface RouteResult {
  path: string[]; // ordered node ids
  totalDistance: number; // sum of baseDistance (meters) — physical walking
  totalCost: number; // sum of edgeCost — the optimization objective
  totalWait: number; // sum of waitTime (minutes) — informational
  segments: SegmentDetail[];
  gateCapacities: GateCapacity[];
}

export interface PathfinderResult {
  status: RouteStatus;
  winner: RouteResult | null;
  /** Best meaningfully-different alternative (typically via a different gate). */
  runnerUp: RouteResult | null;
  reasonData: {
    distanceDelta: number; // winner - runnerUp (m); negative => winner shorter
    costDelta: number; // winner - runnerUp; negative => winner cheaper
    waitDelta: number; // winner - runnerUp (min); negative => winner less waiting
    winnerGate?: string;
    runnerUpGate?: string;
    overCapacityGates: GateCapacity[];
  };
  /** When status is no_accessible_path: the (non-accessible) shortest path, so
   * the XAI layer can explain exactly which segment blocks accessibility. */
  referenceRoute?: RouteResult | null;
  /** Every gate the per-gate ranking considered (winner first). Populated only
   *  for entry/transit -> section trips where there's a gate choice. Lets the
   *  XAI layer say "Gate D was also considered but 15% more crowded." */
  allGates?: GateRanking[];
  closedGates: string[];
}
