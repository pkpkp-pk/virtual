// Gemini tool-use client: the XAI translation layer.
//
// The model does ONLY two things: (1) resolve the user's free-form, any-language
// request to structured params and call find_route, and (2) turn the structured
// result into a clear, multilingual explanation of WHY the route won — citing the
// real numbers the tool returned. It never computes geometry or invents figures.
//
// Model: Gemini Flash. This is translation + explanation of already-computed
// data, not deep reasoning, so a cheap/fast model is the correct engineering
// choice (stated explicitly in the writeup) — not a compromise.

import { GoogleGenAI, createPartFromFunctionResponse, type Part, type Content } from "@google/genai";
import { FIND_ROUTE_DECL, FORECAST_CROWD_DECL, FIND_RENDEZVOUS_DECL, serializeRouteResult } from "./tools";
import { catalogText, resolveNode } from "./nodeCatalog";
import { findRoute } from "../graph/pathfinder";
import { forecastNode, serializeForecast } from "../graph/forecast";
import { findRendezvous, serializeRendezvous } from "../graph/rendezvous";
import { getOccupancy, type OccupancySnapshot } from "../occupancy";
import type { PathfinderResult } from "../types";

// The single Gemini model this layer uses. Pinned to gemini-3.1-flash-lite —
// a cheap/fast Flash-tier model is the correct choice for translation +
// explanation of already-computed data (not deep reasoning). No cascade: if the
// model is unavailable (503/429/timeout) the request degrades to the
// deterministic XAI panel rather than retrying or falling back to another model.
const MODEL = "gemini-3.1-flash-lite";

function getClient(): GoogleGenAI {
  if (!process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY not set");
  return new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY,
    // Fail fast on overload/timeout so the request degrades quickly instead of
    // hanging. The SDK defaults to 5 attempts with backoff on
    // 408/429/500/502/503/504 — that's ~30-50s of retries on a 503 "high
    // demand" before giving up. With a single model and no cascade, there's
    // nothing to fall back to, so disable SDK-level retry (attempts:1) and let
    // the 20s timeout bound a hung call; on failure we degrade gracefully.
    httpOptions: { timeout: 20_000, retryOptions: { attempts: 1 } },
  });
}

const SYSTEM_PROMPT = `You are the XAI Stadium Navigator assistant for MetLife Stadium. Your job is to get a fan to their destination by the FASTEST route RIGHT NOW, accounting for live gate congestion, and to clearly explain WHY that route was chosen.

ARCHITECTURE (important): You do NOT compute routes or distances. A deterministic pathfinding tool (find_route) does all the math. Your job is to (1) understand the user's request in any language, resolve their origin and destination to node ids from the catalog, and call find_route; then (2) explain the result honestly using the exact numbers the tool returns. NEVER invent, round loosely, or guess capacity, wait time, or distance — cite the tool's numbers.

Routable locations (node id — label):
${catalogText()}

RESOLVING THE REQUEST:
- If the user is outside / just arrived / hasn't entered, origin = "entry_plaza". The tool will then choose the best GATE to enter — this is the key decision.
- If they name a gate they're at ("I'm at Gate C"), origin = that gate's id.
- If they name a section/seat as their origin, use that section id.
- Destination is usually a section, amenity, or gate. Match free-form names ("my seat in 126", "nearest restroom", "la salida", "toilettes") to the closest catalog id.
- EGRESS / LEAVING: after the match fans ask for the fastest way OUT to transit or parking ("how do I get to NJ Transit / the parking lot / my rideshare from section 126"). Destination = the transit node id ("nj_transit", "parking_east", "rideshare_dropoff"); origin = their section or gate. The crowd model is in egress phase now — exits and concourses are jammed — so the crowd-aware route matters just as much as on arrival.
- Handle garbled, mixed-language, or misspelled input — still resolve to the best matching ids.
- If the user mentions a wheelchair, stroller, disability, or "accessible"/"accesible"/"silla de ruedas", pass accessible=true.

- If closedGates is non-empty, mention that a gate closure affected the routing.

GROUP RENDEZVOUS:
- If the user mentions friends/group/split up/meet up ("where should we meet", "my friend is at Gate B, I'm at Gate D"), call find_rendezvous with each person's starting node id. Explain the top suggestion: name the meeting spot, its current load, and each person's walking distance/wait. Mention the runner-up spot briefly. Never invent a spot — use what the tool returns.

EXPLAINING THE RESULT (Explainable AI):
- Always respond in the user's language (if mixed, use the dominant one).
- For status "ok": explain the chosen route step-by-step, then explain WHY it beat the runner-up using the comparison: which gate each uses, the distance and wait-time differences, and the live capacity percentages. Example shape: "Gate C is 40 m closer but at 91% capacity (~12 min wait); Gate B is emptier at 30% and net faster, saving you ~9 min." If consideredGates has more than two entries, briefly note one or two next-best alternatives with their load (e.g. "Gate D was also considered but is 15% more crowded.").
- For status "all_over_capacity": say every nearby gate is jammed, list the capacity percentages and wait times, and recommend either waiting (cite the expected wait) or taking the least-bad detour the tool picked. Be honest that there is no fast option right now.
- For status "no_accessible_path": say clearly that no wheelchair-accessible route exists to that destination, and explain WHY using referenceBlockingSegment (e.g. "the only route to Section 300 uses stairs between South Concourse and Section 300"). Do NOT invent an accessible route. Suggest the nearest accessible alternative destination if obvious.
- For status "no_path": say routing isn't possible (e.g. the origin gate is closed) and suggest alternatives.

FORECASTING (real-time decision support):
- If the winning route goes through a gate that is over capacity (>=90%), call forecast_crowd for that gate BEFORE finalizing your explanation. Use the projection to tell the fan whether waiting helps: e.g. "Gate C is at 91% now but is forecast to drop below 70% (~68%) in about 4 min — if you can wait, it gets better." If the forecast says it won't clear soon, say so honestly and recommend the least-bad option the route tool picked. Never invent forecast numbers — cite the tool's.

CONFIDENCE FRAMING: occupancy is a live estimate, not a certainty. Phrase load-based statements as "currently at ~91%", "trending toward", or "expected to" rather than flat absolutes. Distances and the route topology ARE exact — state those plainly.

SUSTAINABILITY NUDGE: when the destination or exit is NJ Transit (nj_transit), note in one phrase that it is the lower-footprint way to/from MetLife vs driving. Do not belabor it — a single clause, only when transit is actually part of the answer.

Keep it concise, concrete, and human. Lead with the recommendation, then the why. Use the real numbers from the tool.`;

export interface ChatOutcome {
  text: string;
  routeResult: PathfinderResult | null;
  occupancySource: string;
  scenarioTime: number;
  /** True when the LLM explanation was unavailable (API error / timeout) but the
   *  deterministic route still computed — the client falls back to the XAI panel. */
  degraded?: boolean;
}

export interface RunChatOptions {
  /** When set, forces the find_route `accessible` parameter to this value,
   *  overriding whatever the model emitted. Accessibility is a safety-critical
   *  parameter, so it must be deterministic — never left to the LLM's inference.
   *  Undefined = let the model decide (back-compat for free-text requests). */
  accessible?: boolean;
  /** Prior conversation turns (most recent last) so follow-ups like "what about
   *  the accessible one?" resolve against context. Text-only parts are fine —
   *  the tool-call transcript is not replayed, just the human/model language. */
  history?: Content[];
}

/** Force the accessible flag onto a find_route call's args. Pure + unit-testable
 *  (no Gemini call needed): when `forced` is undefined the args are untouched and
 *  the model decides; when set, the override wins regardless of what the model
 *  emitted — even if it incorrectly omitted or set false. */
export function applyForcedAccess(
  args: { from?: string; to?: string; accessible?: boolean },
  forced?: boolean
): { from?: string; to?: string; accessible?: boolean } {
  if (forced === undefined) return args;
  return { ...args, accessible: forced };
}

/** A single model function call (the subset of @google/genai's FunctionCall we
 *  use — kept loose so the dispatcher is unit-testable without the genai types). */
export interface ToolCall {
  id?: string;
  name?: string;
  args?: Record<string, unknown>;
}

export interface DispatchOutcome {
  /** The function-response payload (provider-agnostic). Each provider wraps it
   *  in its own wire format (Gemini Part / OpenAI tool message). */
  response: Record<string, unknown>;
  /** Set when a find_route call produced a route — the loop records it as the
   *  latest routeResult for the client. */
  routeResult?: PathfinderResult;
}

/** Pure dispatcher: turn one model function call into the function-response
 *  payload + any routeResult it produced. No Gemini, no Firebase — fully
 *  unit-testable. This is the entire 3-tool loop's per-call logic (find_route /
 *  forecast_crowd / find_rendezvous) extracted so worst-case paths (forced
 *  accessibility, node-resolution failure, unknown tool) can be pinned by
 *  tests, and so any LLM provider can reuse it. */
export function dispatchToolCall(
  fc: ToolCall,
  opts: RunChatOptions | undefined,
  occ: OccupancySnapshot
): DispatchOutcome {
  if (fc.name === "find_route") {
    const args = applyForcedAccess(
      (fc.args ?? {}) as { from?: string; to?: string; accessible?: boolean },
      opts?.accessible
    );
    const from = resolveNode(args.from ?? "");
    const to = resolveNode(args.to ?? "");
    if (!from || !to) {
      return {
        response: {
          status: "error",
          error: `Could not resolve ${!from ? "origin" : "destination"} "${!from ? args.from : args.to}". Ask the user to clarify, or pick the closest catalog id.`,
        },
      };
    }
    const r = findRoute({
      from,
      to,
      constraints: { accessible: args.accessible },
      occupancy: occ.state,
      closedGates: occ.closedGates,
    });
    return {
      routeResult: r,
      response: serializeRouteResult(r) as Record<string, unknown>,
    };
  }
  if (fc.name === "forecast_crowd") {
    const fargs = (fc.args ?? {}) as { node?: string; horizonMin?: number };
    const node = resolveNode(fargs.node ?? "");
    if (!node) {
      return {
        response: {
          status: "error",
          error: `Could not resolve node "${fargs.node}". Ask the user to clarify, or pick the closest catalog id.`,
        },
      };
    }
    const fc2 = forecastNode(
      node,
      occ.t,
      fargs.horizonMin && fargs.horizonMin > 0 ? fargs.horizonMin : 15,
      1
    );
    return {
      response: serializeForecast(fc2),
    };
  }
  if (fc.name === "find_rendezvous") {
    const rargs = (fc.args ?? {}) as { starts?: string[]; accessible?: boolean };
    const starts = (rargs.starts ?? [])
      .map((s) => resolveNode(String(s ?? "")))
      .filter((s): s is string => !!s);
    if (starts.length < 2) {
      return {
        response: {
          status: "error",
          error:
            "Need at least two distinct starting locations. Ask the user where each person is right now.",
        },
      };
    }
    const rr = findRendezvous({
      starts,
      constraints: {
        accessible:
          rargs.accessible === true || opts?.accessible === true
            ? true
            : rargs.accessible === false
            ? false
            : undefined,
      },
      occupancy: occ.state,
      closedGates: occ.closedGates,
    });
    return {
      response: serializeRendezvous(rr),
    };
  }
  return {
    response: {
      error: "unknown function",
    },
  };
}

/** One model attempt (non-streaming). Throws on any Gemini error so the caller
 *  can degrade gracefully. */
async function runChatWithModel(
  userQuery: string,
  opts: RunChatOptions | undefined,
  occ: OccupancySnapshot,
  ai: GoogleGenAI
): Promise<ChatOutcome> {
  const chat = ai.chats.create({
    model: MODEL,
    config: {
      systemInstruction: SYSTEM_PROMPT,
      tools: [{ functionDeclarations: [FIND_ROUTE_DECL, FORECAST_CROWD_DECL, FIND_RENDEZVOUS_DECL] }],
      temperature: 0.2,
    },
    history: opts?.history ?? [],
  });

  let routeResult: PathfinderResult | null = null;
  let res = await chat.sendMessage({ message: userQuery });
  for (let i = 0; i < 6; i++) {
    const calls = res.functionCalls ?? [];
    if (calls.length === 0) break;
    const parts: Part[] = [];
    for (const fc of calls) {
      const out = dispatchToolCall(fc, opts, occ);
      if (out.routeResult) routeResult = out.routeResult;
      parts.push(
        createPartFromFunctionResponse(
          fc.id ?? fc.name ?? "find_route",
          fc.name ?? "find_route",
          out.response
        )
      );
    }
    res = await chat.sendMessage({ message: parts });
  }
  const text = res.text ?? "";
  return { text, routeResult, occupancySource: occ.source, scenarioTime: occ.t };
}

export async function runChat(
  userQuery: string,
  opts?: RunChatOptions
): Promise<ChatOutcome> {
  const ai = getClient(); // throws on missing key -> route surfaces a 500 config error
  const occ = await getOccupancy();
  try {
    return await runChatWithModel(userQuery, opts, occ, ai);
  } catch (err) {
    console.warn(`[runChat] ${MODEL} failed:`, err);
    return {
      text: "I couldn't reach the live explanation service right now (it timed out or hit its free-tier limit). Please try again in a moment.",
      routeResult: null,
      occupancySource: occ.source,
      scenarioTime: occ.t,
      degraded: true,
    };
  }
}

/** One model attempt (streaming). Pipes text to `onText` as it arrives; throws
 *  on any Gemini error so the caller can degrade. Does NOT emit a degrade
 *  message itself — the caller decides. */
async function runChatStreamWithModel(
  userQuery: string,
  opts: RunChatOptions | undefined,
  occ: OccupancySnapshot,
  ai: GoogleGenAI,
  onText: (delta: string) => void,
  onRoute?: (r: PathfinderResult, source: string, t: number) => void
): Promise<ChatOutcome> {
  const chat = ai.chats.create({
    model: MODEL,
    config: {
      systemInstruction: SYSTEM_PROMPT,
      tools: [{ functionDeclarations: [FIND_ROUTE_DECL, FORECAST_CROWD_DECL, FIND_RENDEZVOUS_DECL] }],
      temperature: 0.2,
    },
    history: opts?.history ?? [],
  });

  let routeResult: PathfinderResult | null = null;
  let text = "";
  let message: string | Part[] = userQuery;
  for (let round = 0; round < 8; round++) {
    const calls: ToolCall[] = [];
    let roundText = "";
    const stream = await chat.sendMessageStream({ message });
    for await (const chunk of stream) {
      if (chunk.text) {
        roundText += chunk.text;
        onText(chunk.text);
      }
      if (chunk.functionCalls && chunk.functionCalls.length) {
        calls.push(...chunk.functionCalls);
      }
    }
    text += roundText;
    if (!calls || calls.length === 0) break; // final answer already streamed
    const parts: Part[] = [];
    for (const fc of calls) {
      const out = dispatchToolCall(fc, opts, occ);
      if (out.routeResult) {
        routeResult = out.routeResult;
        // Surface the deterministic route to the client the instant it's
        // computed — the pathfinder is microsecond-fast, but the model's
        // explanation round that follows is ~15s. Emitting the route now lets
        // the map + "Why this route?" panel render the real answer while the
        // prose streams in.
        onRoute?.(out.routeResult, occ.source, occ.t);
      }
      parts.push(
        createPartFromFunctionResponse(
          fc.id ?? fc.name ?? "find_route",
          fc.name ?? "find_route",
          out.response
        )
      );
    }
    message = parts;
  }
  return { text, routeResult, occupancySource: occ.source, scenarioTime: occ.t };
}

/** Streaming variant: pipes the model's text to `onText` as it arrives while
 *  running the 3-tool loop. If the model fails before streaming any text, emits
 *  a degrade message and returns a degraded outcome (the client falls back to
 *  the deterministic XAI panel). If it fails mid-stream, keep what we have. */
export async function runChatStream(
  userQuery: string,
  opts: RunChatOptions | undefined,
  onText: (delta: string) => void,
  onRoute?: (r: PathfinderResult, source: string, t: number) => void
): Promise<ChatOutcome> {
  const ai = getClient();
  const occ = await getOccupancy();
  let emitted = false;
  const wrappedOnText = (delta: string) => {
    emitted = true;
    onText(delta);
  };
  try {
    return await runChatStreamWithModel(userQuery, opts, occ, ai, wrappedOnText, onRoute);
  } catch (err) {
    console.warn(`[runChatStream] ${MODEL} failed:`, err);
    const degradedText =
      "I couldn't reach the live explanation service right now (it timed out or hit its free-tier limit). Please try again in a moment.";
    if (!emitted) onText(degradedText);
    return {
      text: degradedText,
      routeResult: null,
      occupancySource: occ.source,
      scenarioTime: occ.t,
      degraded: true,
    };
  }
}

