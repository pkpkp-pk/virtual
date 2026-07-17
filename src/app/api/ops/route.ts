// GET /api/ops  (header X-Ops-Secret: <OPS_SECRET> when OPS_SECRET is set)
// -> { phase, t, closedGates, gateStatuses, gateLoads, topGates, recentEvents, source }
//
// Read-only organizer view (Phase 6): aggregates per-gate route-request counts,
// recent alert events, and the current live gate loads + phase. Protected by an
// optional shared secret; if OPS_SECRET is unset the endpoint is open (fine for a
// demo — the data is non-sensitive aggregates).

import { NextResponse } from "next/server";
import { getOccupancy } from "@/lib/occupancy";
import { NODE_LIST, nodeLabel } from "@/lib/graph/stadiumGraph";
import { capacityPct } from "@/lib/graph/jitter";
import {
  firebaseConfigured,
  readRouteStats,
  readRecentEvents,
} from "@/lib/firebase/admin";
import { computeGateStatuses, type CrowdEvent } from "@/lib/events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const secret = process.env.OPS_SECRET;
  if (secret) {
    const provided = req.headers.get("x-ops-secret");
    if (provided !== secret) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  }

  const occ = await getOccupancy();

  const gateLoads = NODE_LIST.filter((n) => n.type === "gate").map((n) => {
    const occupancy = occ.state[n.id] ?? 0;
    const pct = capacityPct(occupancy, n.capacity);
    return {
      id: n.id,
      label: n.label,
      occupancy,
      capacityPct: pct,
      over: pct >= 0.9,
    };
  });

  let topGates: { gateId: string; label: string; count: number; lastAt: number }[] = [];
  let recentEvents: CrowdEvent[] = [];
  if (firebaseConfigured()) {
    try {
      const stats = await readRouteStats();
      topGates = stats.map((s) => ({
        gateId: s.gateId,
        label: nodeLabel(s.gateId),
        count: s.count,
        lastAt: s.lastAt,
      }));
      recentEvents = await readRecentEvents(20);
    } catch (err) {
      console.warn("[/api/ops] stats/events read failed:", err);
    }
  }

  return NextResponse.json(
    {
      phase: occ.phase,
      t: occ.t,
      closedGates: occ.closedGates,
      gateStatuses: computeGateStatuses(occ.state),
      gateLoads,
      topGates,
      recentEvents,
      source: occ.source,
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
