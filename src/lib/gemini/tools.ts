// Gemini tool declarations + the serializer that turns a PathfinderResult into
// a compact, model-friendly object. The numbers here are the ground truth the
// model's explanation must cite — it never invents capacity or wait figures.

import type { FunctionDeclaration } from "@google/genai";
import type { PathfinderResult, RouteResult, SegmentDetail } from "../types";
import { nodeLabel } from "../graph/stadiumGraph";

export const FIND_ROUTE_DECL: FunctionDeclaration = {
  name: "find_route",
  description:
    "Compute the fastest crowd-aware route between two stadium locations right now. " +
    "Resolve the user's free-form origin/destination (any language) to node ids from the catalog, " +
    "then call this. Returns the winning route, a runner-up via a different gate, live capacity " +
    "and wait-time numbers, and a status that may indicate an edge case (all gates over capacity, " +
    "no accessible route, a closed gate). Use the returned numbers verbatim in your explanation.",
  parametersJsonSchema: {
    type: "object",
    properties: {
      from: {
        type: "string",
        description: "Origin node id from the catalog (e.g. 'entry_plaza', 'gate_c', 'sec_126').",
      },
      to: {
        type: "string",
        description: "Destination node id from the catalog.",
      },
      accessible: {
        type: "boolean",
        description:
          "Set true if the user needs a wheelchair-accessible route. Omit/false otherwise.",
      },
    },
    required: ["from", "to"],
  },
};

export const FORECAST_CROWD_DECL: FunctionDeclaration = {
  name: "forecast_crowd",
  description:
    "Project a single location's crowd load forward in time using the deterministic crowd model. " +
    "Call this when a gate on the chosen route is over capacity (>=90%) to tell the fan whether " +
    "waiting will help — e.g. 'Gate C is at 91% now but drops to 68% in ~4 min.' Returns the " +
    "current load and a per-minute forecast. Cite the returned percentages verbatim.",
  parametersJsonSchema: {
    type: "object",
    properties: {
      node: {
        type: "string",
        description: "Node id to forecast (typically a gate id like 'gate_c').",
      },
      horizonMin: {
        type: "number",
        description: "How many minutes ahead to project (default 15).",
      },
    },
    required: ["node"],
  },
};

export const FIND_RENDEZVOUS_DECL: FunctionDeclaration = {
  name: "find_rendezvous",
  description:
    "Suggest a meeting spot for a group that got split up. Given each person's " +
    "starting location (>=2), it scores every amenity/concourse by combined " +
    "travel cost from all starts penalized by current crowd load, and returns " +
    "the best spots with each person's route. Call this when the user mentions " +
    "friends/group/split up/meet up. Cite the meeting spot, its current load, " +
    "and each person's walking distance verbatim.",
  parametersJsonSchema: {
    type: "object",
    properties: {
      starts: {
        type: "array",
        items: { type: "string" },
        description:
          "Each person's starting node id (e.g. ['gate_b','gate_d','sec_126']). " +
          "Resolve free-form locations ('my friend is at Gate B, I'm at Gate D') to ids.",
      },
      accessible: {
        type: "boolean",
        description:
          "Set true if anyone in the group needs a wheelchair-accessible meeting point.",
      },
    },
    required: ["starts"],
  },
};

function serializeRoute(r: RouteResult): unknown {
  return {
    path: r.path.map((id) => nodeLabel(id)),
    pathIds: r.path,
    totalDistanceMeters: r.totalDistance,
    totalWaitMinutes: r.totalWait,
    totalCost: r.totalCost,
    gates: r.gateCapacities.map((g) => ({
      name: g.label,
      occupancy: g.occupancy,
      capacity: g.capacity,
      capacityPct: Math.round(g.capacityPct * 100) + "%",
    })),
    segments: r.segments.map((s: SegmentDetail) => ({
      from: nodeLabel(s.from),
      to: nodeLabel(s.to),
      distanceMeters: s.baseDistance,
      arrivalLoad: Math.round(s.capacityPct * 100) + "%",
      crowdMultiplier: Math.round(s.crowdMultiplier * 100) / 100,
      waitMinutes: Math.round(s.waitTime * 10) / 10,
      accessible: s.accessible,
    })),
  };
}

/** Curate the pathfinder result for the model: drop huge internals, keep the
 *  numbers and the comparison the XAI explanation needs. */
export function serializeRouteResult(res: PathfinderResult): unknown {
  return {
    status: res.status,
    closedGates: res.closedGates.map(nodeLabel),
    winner: res.winner ? serializeRoute(res.winner) : null,
    runnerUp: res.runnerUp ? serializeRoute(res.runnerUp) : null,
    comparison:
      res.winner && res.runnerUp
        ? {
            winnerGate: res.reasonData.winnerGate ? nodeLabel(res.reasonData.winnerGate) : null,
            runnerUpGate: res.reasonData.runnerUpGate ? nodeLabel(res.reasonData.runnerUpGate) : null,
            distanceDeltaMeters: res.reasonData.distanceDelta,
            waitDeltaMinutes: res.reasonData.waitDelta,
            winnerTotalWait: res.winner.totalWait,
            runnerUpTotalWait: res.runnerUp.totalWait,
            winnerDistance: res.winner.totalDistance,
            runnerUpDistance: res.runnerUp.totalDistance,
          }
        : null,
    overCapacityGates: res.reasonData.overCapacityGates.map((g) => ({
      name: g.label,
      capacityPct: Math.round(g.capacityPct * 100) + "%",
    })),
    // Full gate ranking the pathfinder considered (winner first). Use this to
    // mention the next-best alternatives, e.g. "Gate D was also considered but
    // is 15% more crowded."
    consideredGates: (res.allGates ?? []).map((g, i) => ({
      rank: i + 1,
      name: g.label,
      capacityPct: Math.round(g.capacityPct * 100) + "%",
      waitMinutes: g.totalWait,
      totalCost: g.totalCost,
    })),
    // For no_accessible_path: show the non-accessible reference route and which
    // segment blocks accessibility, so the model can explain honestly.
    referenceRoute: res.referenceRoute ? serializeRoute(res.referenceRoute) : null,
    referenceBlockingSegment: res.referenceRoute?.segments.find((s) => !s.accessible)
      ? {
          from: nodeLabel(res.referenceRoute!.segments.find((s) => !s.accessible)!.from),
          to: nodeLabel(res.referenceRoute!.segments.find((s) => !s.accessible)!.to),
        }
      : null,
  };
}
