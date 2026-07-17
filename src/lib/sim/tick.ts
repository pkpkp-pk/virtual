// Manual simulation tick: computes jitter(now), runs the alert-detection cycle
// (events + FCM), and reports hotspots. On the Spark plan there is NO Cloud
// Scheduler, so this is a manual admin trigger (POST /api/sim/tick with
// X-Cron-Secret, or `npm run sim:tick`) — the normal liveness + event detection
// happens on-demand inside /api/crowd via the client poll. Occupancy is never
// persisted (jitter computes it on read), so this no longer writes a snapshot.

import { NODE_LIST } from "../graph/stadiumGraph";
import { getOccupancy } from "../occupancy";
import { runAlertCycle } from "../alerting";
import { capacityPct, type ScenarioPhase } from "../graph/jitter";
import type { CrowdEvent } from "../events";
import type { OccupancyState } from "../types";

export interface TickResult {
  t: number;
  phase: ScenarioPhase;
  events: CrowdEvent[];
  closedGates: string[];
  state: OccupancyState;
  hotspots: { id: string; label: string; capacityPct: number }[];
}

export async function tickOnce(): Promise<TickResult> {
  const occ = await getOccupancy();
  const events = await runAlertCycle(occ.state, occ.phase, Date.now());

  const hotspots = NODE_LIST.map((n) => ({
    id: n.id,
    label: n.label,
    capacityPct: capacityPct(occ.state[n.id] ?? 0, n.capacity),
  }))
    .filter((h) => h.capacityPct >= 0.9)
    .sort((a, b) => b.capacityPct - a.capacityPct)
    .slice(0, 5);

  return {
    t: occ.t,
    phase: occ.phase,
    events,
    closedGates: occ.closedGates,
    state: occ.state,
    hotspots,
  };
}

