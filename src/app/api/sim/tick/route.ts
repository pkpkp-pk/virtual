// POST /api/sim/tick  (header X-Cron-Secret: <SIM_CRON_SECRET>)
// MANUAL admin trigger: runs the alert-detection cycle (events + FCM) once and
// returns hotspots. There is no Cloud Scheduler on the Spark plan and Vercel
// Hobby's cron is daily-only, so this is NOT driven on a cron — normal liveness
// + detection happen on-demand inside /api/crowd via the client poll. Use this
// (or `npm run sim:tick`) to force a detection pass for a demo. The secret
// header keeps it from random traffic.

import { NextResponse } from "next/server";
import { tickOnce } from "@/lib/sim/tick";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const secret = process.env.SIM_CRON_SECRET;
  if (secret) {
    const provided = req.headers.get("x-cron-secret");
    if (provided !== secret) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  }
  const res = await tickOnce();
  return NextResponse.json(res);
}

export async function GET() {
  // Convenience: same as POST but for ad-hoc browser/dev triggers.
  return POST(new Request("http://localhost", { method: "POST" }));
}
