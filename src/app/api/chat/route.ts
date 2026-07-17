// POST /api/chat  { query, accessible?, history? }
// -> NDJSON stream: lines of {"type":"text","delta":"..."} then a final
//    {"type":"done","routeResult":...,"occupancySource":...,"scenarioTime":...,"degraded":?}
//    (or {"type":"error","error":"..."}).
//
// Streams the Gemini explanation chunk-by-chunk (runChatStream) while still
// running the 3-tool loop. `accessible` is forced into the tool call — never
// inferred from the query. Cost guard: per-IP rate limit + short-lived cache
// (a cache hit emits the cached text as one chunk + the cached outcome).

import type { Content } from "@google/genai";
import { runChatStream } from "@/lib/gemini/client";
import { firebaseConfigured, incrementRouteStat } from "@/lib/firebase/admin";
import { rateLimited, withCache } from "@/lib/chatGuard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface WireTurn {
  role: "user" | "assistant";
  text: string;
}

export async function POST(req: Request) {
  let query: string;
  let accessible: boolean | undefined;
  let wireHistory: WireTurn[] = [];
  try {
    const body = await req.json();
    query = String(body?.query ?? "").trim();
    accessible =
      body?.accessible === true || body?.accessible === false
        ? body.accessible
        : undefined;
    if (Array.isArray(body?.history)) {
      wireHistory = (body.history as WireTurn[])
        .filter((t) => t && typeof t.text === "string" && t.text.trim())
        .slice(-6)
        .map((t) => ({ role: t.role === "assistant" ? "assistant" : "user", text: t.text }));
    }
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (!query) return Response.json({ error: "query is required" }, { status: 400 });

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  if (rateLimited(ip)) {
    return Response.json({ error: "Too many requests. Please slow down." }, { status: 429 });
  }
  const cacheable = wireHistory.length === 0;
  const history: Content[] = wireHistory.map((t) => ({
    role: t.role === "assistant" ? "model" : "user",
    parts: [{ text: t.text }],
  }));

  const encoder = new TextEncoder();
  const emit = (controller: ReadableStreamDefaultController, obj: unknown) =>
    controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));

  const stream = new ReadableStream({
    async start(controller) {
      try {
        if (cacheable) {
          const cached = withCache.get(query, accessible);
          if (cached) {
            if (cached.text) emit(controller, { type: "text", delta: cached.text });
            emit(controller, {
              type: "done",
              routeResult: cached.routeResult,
              occupancySource: cached.occupancySource,
              scenarioTime: cached.scenarioTime,
              degraded: cached.degraded,
            });
            return;
          }
        }
        const outcome = await runChatStream(
          query,
          { accessible, history },
          (delta) => emit(controller, { type: "text", delta }),
          // Emit the deterministic route the moment the pathfinder computes it
          // (microseconds) — well before the model's explanation finishes
          // streaming (~15s). The client draws the route + XAI panel immediately.
          (routeResult, occupancySource, scenarioTime) =>
            emit(controller, { type: "route", routeResult, occupancySource, scenarioTime })
        );
        // Don't cache degraded outcomes — a retry should re-attempt the model
        // (it may have recovered from a transient 503/429 by then).
        if (cacheable && !outcome.degraded) withCache.set(query, accessible, outcome);
        const gate = outcome.routeResult?.winner?.gateCapacities[0]?.id;
        if (gate && firebaseConfigured()) {
          incrementRouteStat(gate).catch(() => {});
        }
        emit(controller, {
          type: "done",
          routeResult: outcome.routeResult,
          occupancySource: outcome.occupancySource,
          scenarioTime: outcome.scenarioTime,
          degraded: outcome.degraded,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : "unknown error";
        console.error("[/api/chat] stream failed:", msg);
        emit(controller, { type: "error", error: msg });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
