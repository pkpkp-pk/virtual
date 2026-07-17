// POST /api/sim/gates  { closedGates: string[] }   // set the closed-gate set
// GET  /api/sim/gates                       -> { closedGates, source }
//
// Demo control to inject a gate-closure mid-session and trigger live
// recalculation. Persists to Firestore `gates/closed` when configured (survives
// restarts and is shared across instances), else dev in-memory state.

import { NextResponse } from "next/server";
import {
  firebaseConfigured,
  readClosedGates,
  writeClosedGates,
} from "@/lib/firebase/admin";
import { getDevClosedGates, setDevClosedGates } from "@/lib/sim/state";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  let closedGates: string[];
  if (firebaseConfigured()) {
    try {
      closedGates = await readClosedGates();
    } catch (err) {
      console.warn("[/api/sim/gates] read failed:", err);
      closedGates = getDevClosedGates();
    }
  } else {
    closedGates = getDevClosedGates();
  }
  return NextResponse.json({
    closedGates,
    source: firebaseConfigured() ? "firestore" : "memory",
  });
}

export async function POST(req: Request) {
  let closedGates: string[];
  try {
    const body = await req.json();
    closedGates = Array.isArray(body?.closedGates) ? body.closedGates.map(String) : [];
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (firebaseConfigured()) {
    try {
      await writeClosedGates(closedGates);
    } catch (err) {
      console.warn("[/api/sim/gates] write failed:", err);
      setDevClosedGates(closedGates);
    }
  } else {
    setDevClosedGates(closedGates);
  }
  return NextResponse.json({
    closedGates,
    source: firebaseConfigured() ? "firestore" : "memory",
  });
}
