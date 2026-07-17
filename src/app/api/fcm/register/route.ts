// POST /api/fcm/register  { token: string, gateId?: string }
// -> { ok: true, topics: string[] }
//
// Subscribe an FCM registration token to alert topics so the fan gets push
// notifications even with the app backgrounded. Always subscribed to `global`;
// if a gate is supplied (the fan's ticket gate), also subscribed to
// `gate_{gateId}` for personalized "YOUR gate just hit 95%" pushes. Topic-based
// so no per-user token storage is needed. The server does the subscribe (the
// client can't subscribe itself to a topic).

import { NextResponse } from "next/server";
import { firebaseConfigured, subscribeToTopic } from "@/lib/firebase/admin";
import { NODE_MAP } from "@/lib/graph/stadiumGraph";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let token: string;
  let gateId: string | undefined;
  try {
    const body = await req.json();
    token = String(body?.token ?? "").trim();
    gateId = body?.gateId ? String(body.gateId) : undefined;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (!token) {
    return NextResponse.json({ error: "token is required" }, { status: 400 });
  }
  if (!firebaseConfigured()) {
    return NextResponse.json(
      { error: "Firebase not configured on the server" },
      { status: 503 }
    );
  }
  const topics = ["global"];
  if (gateId && NODE_MAP[gateId]?.type === "gate") {
    topics.push(`gate_${gateId}`);
  }
  try {
    for (const topic of topics) {
      await subscribeToTopic([token], topic);
    }
  } catch (err) {
    console.error("[/api/fcm/register] subscribe failed:", err);
    return NextResponse.json({ error: "subscribe failed" }, { status: 500 });
  }
  return NextResponse.json({ ok: true, topics });
}
