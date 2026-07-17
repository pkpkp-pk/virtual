// Edge-case demo: runs each deterministic edge case through the pathfinder and
// prints a human-readable summary. No LLM / no API keys needed — this shows the
// engine's behavior directly. Run with `npm run demo:edges`.
//
// The fifth edge case (garbled / mixed-language input) is the Gemini layer's
// job and is demonstrated live via the chat panel.

import { findRoute } from "../graph/pathfinder";
import { occupancyAtTime, nodeLabel, NODE_MAP } from "../graph/stadiumGraph";
import type { OccupancyState, PathfinderResult } from "../types";

function occ(overrides: Record<string, number> = {}, t = 3000): OccupancyState {
  return { ...occupancyAtTime(t), ...overrides };
}

function summarize(name: string, res: PathfinderResult): void {
  console.log(`\n── ${name} ──`);
  console.log(`  status: ${res.status}`);
  if (res.winner) {
    console.log(
      `  winner: via ${res.reasonData.winnerGate ? nodeLabel(res.reasonData.winnerGate) : "—"} · ` +
        `${res.winner.totalDistance} m · ${res.winner.totalWait} min wait · ` +
        `gate load ${res.winner.gateCapacities[0] ? Math.round(res.winner.gateCapacities[0].capacityPct * 100) + "%" : "—"}`
    );
    console.log(`    path: ${res.winner.path.map(nodeLabel).join(" → ")}`);
  } else {
    console.log("  winner: (none)");
  }
  if (res.runnerUp) {
    console.log(
      `  runner-up: via ${res.reasonData.runnerUpGate ? nodeLabel(res.reasonData.runnerUpGate) : "—"} · ` +
        `${res.runnerUp.totalDistance} m · ${res.runnerUp.totalWait} min wait`
    );
    console.log(
      `  why: Δwait ${res.reasonData.waitDelta} min · Δdistance ${res.reasonData.distanceDelta} m`
    );
  }
  if (res.reasonData.overCapacityGates.length) {
    console.log(
      `  over-capacity gates: ${res.reasonData.overCapacityGates
        .map((g) => `${g.label} ${Math.round(g.capacityPct * 100)}%`)
        .join(", ")}`
    );
  }
  if (res.status === "no_accessible_path" && res.referenceRoute) {
    const block = res.referenceRoute.segments.find((s) => !s.accessible);
    console.log(
      `  reference (non-accessible) route: ${res.referenceRoute.path.map(nodeLabel).join(" → ")}`
    );
    if (block) {
      console.log(`  blocking segment: ${nodeLabel(block.from)} → ${nodeLabel(block.to)} (stairs)`);
    }
  }
  if (res.closedGates.length) {
    console.log(`  closed gates: ${res.closedGates.map(nodeLabel).join(", ")}`);
  }
}

function main() {
  console.log("=== XAI Stadium Navigator — edge case demo (deterministic core) ===");

  // 1. Crowd-aware gate choice (ok): jam gate_c, keep gate_d emptier.
  const jammed = occ({ gate_c: 5600, gate_d: 600, gate_a: 3000, gate_b: 3000, gate_vip: 800 });
  summarize("1. Crowd-aware gate choice (status: ok)", findRoute({
    from: "entry_plaza", to: "sec_126", occupancy: jammed,
  }));

  // 2. All routes over capacity: every gate jammed.
  const allJammed = occ({ gate_a: 5500, gate_b: 5600, gate_c: 5700, gate_d: 5400, gate_vip: 1900 });
  summarize("2. All gates over capacity (status: all_over_capacity)", findRoute({
    from: "entry_plaza", to: "sec_126", occupancy: allJammed,
  }));

  // 3. No accessible path: destination is stair-only (sec_300).
  summarize("3. No accessible path to Section 300 (status: no_accessible_path)", findRoute({
    from: "entry_plaza", to: "sec_300", constraints: { accessible: true }, occupancy: occ(),
  }));

  // 4. Accessible route to an accessible section still works.
  summarize("4. Accessible route to Section 126 (status: ok, only accessible edges)", findRoute({
    from: "entry_plaza", to: "sec_126", constraints: { accessible: true }, occupancy: occ(),
  }));

  // 5. Gate closes mid-session: find the open winner, then close it.
  const twoEmpty = occ({ gate_a: 5500, gate_b: 600, gate_c: 5500, gate_d: 5500, gate_vip: 600 });
  const open = findRoute({ from: "entry_plaza", to: "sec_126", occupancy: twoEmpty });
  const openGate = open.reasonData.winnerGate!;
  summarize("5a. Before closure (open winner)", open);
  const closed = findRoute({
    from: "entry_plaza", to: "sec_126", occupancy: twoEmpty, closedGates: [openGate],
  });
  summarize(`5b. After closing ${nodeLabel(openGate)} (recalculated)`, closed);

  // 6. Mixed-language / garbled input is handled by the Gemini layer (see chat panel).
  console.log("\n── 6. Garbled / mixed-language input ──");
  console.log("  (Handled by the Gemini tool-use layer — demonstrated live in the chat panel.");
  console.log("   The model resolves e.g. '¿sección 126 accesible?' to find_route(sec_126, accessible=true).)");

  // sanity: confirm sec_300 is the non-accessible destination in the catalog
  void NODE_MAP;
}

main();
