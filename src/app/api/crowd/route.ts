// GET /api/crowd
// -> { source, t, phase, closedGates, thresholds, nodes: [...] }
//
// Snapshot of the live crowd state for the SVG map. Occupancy is computed from
// the pure jitter(t) model (never read from Firestore), so the map evolves on
// its own with no scheduler. The client polls this every few seconds.
//
// On a throttled cadence (~once per 30s per instance) this endpoint ALSO runs
// the alert-detection cycle: it compares the current per-gate load to the last-
// seen gate state, and on a threshold crossing or phase flip writes an `events`
// doc and fires an FCM push. That's how liveness + proactive alerts work with
// no Cloud Scheduler — detection piggybacks on the poll.

import { NextResponse } from "next/server";
import { getOccupancy } from "@/lib/occupancy";
import { NODE_LIST } from "@/lib/graph/stadiumGraph";
import { capacityPct } from "@/lib/graph/jitter";
import { firebaseConfigured, getThresholds } from "@/lib/firebase/admin";
import { runAlertCycle } from "@/lib/alerting";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Per-instance throttle (module state survives across invocations on a warm
// serverless instance). Crossings evolve over seconds/minutes, so ~30s
// detection granularity is plenty and keeps Firestore reads/writes bounded.
let lastDetectAt = 0;
const DETECT_THROTTLE_MS = 30_000;

export async function GET() {
  const occ = await getOccupancy();
  const thresholds = await getThresholds();
  const now = Date.now();

  if (firebaseConfigured() && now - lastDetectAt > DETECT_THROTTLE_MS) {
    lastDetectAt = now;
    // Fire-and-forget: detection must not delay or break the crowd response.
    runAlertCycle(occ.state, occ.phase, now, thresholds.overCapacityThreshold).catch(
      (err) => console.warn("[/api/crowd] alert cycle failed:", err)
    );
  }

  const nodes = NODE_LIST.map((n) => {
    const occupancy = occ.state[n.id] ?? 0;
    return {
      id: n.id,
      label: n.label,
      type: n.type,
      lat: n.lat,
      lng: n.lng,
      capacity: n.capacity,
      accessible: n.accessible,
      occupancy,
      capacityPct: capacityPct(occupancy, n.capacity),
    };
  });

  return NextResponse.json(
    {
      source: occ.source,
      t: occ.t,
      phase: occ.phase,
      closedGates: occ.closedGates,
      thresholds,
      nodes,
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
