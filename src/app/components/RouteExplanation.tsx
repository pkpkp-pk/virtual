"use client";

import { useEffect, useState } from "react";
import { nodeLabel, NODE_MAP } from "@/lib/graph/stadiumGraph";
import { gateWaitRecommendation } from "@/lib/graph/forecast";
import { accessPhotoUrl } from "@/lib/firebase/storage";
import { useI18n } from "@/lib/i18n";
import type { PathfinderResult } from "@/lib/types";

const STATUS_LABEL: Record<string, { text: string; color: string }> = {
  ok: { text: "Optimal route found", color: "#2dd4bf" },
  all_over_capacity: { text: "All gates over capacity", color: "#f97316" },
  no_accessible_path: { text: "No accessible route", color: "#ef4444" },
  no_path: { text: "No route available", color: "#ef4444" },
};

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

export default function RouteExplanation({
  result,
  t = 0,
  calmThreshold = 0.7,
}: {
  result: PathfinderResult | null;
  t?: number;
  calmThreshold?: number;
}) {
  // Accessibility entrance photo for the winner gate (Phase 5). Hooks must run
  // before any early return, so derive the gate id with optional chaining.
  const winnerGate = result?.winner?.gateCapacities[0]?.id;
  const winnerGateAccessible = winnerGate
    ? NODE_MAP[winnerGate]?.accessible === true
    : false;
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!winnerGate || !winnerGateAccessible) return;
    let cancelled = false;
    accessPhotoUrl(winnerGate).then((u) => {
      if (!cancelled) setPhotoUrl(u);
    });
    return () => {
      cancelled = true;
    };
  }, [winnerGate, winnerGateAccessible]);

  // Audio directions (Web Speech API) — read the winner route aloud. Helps
  // visually-impaired fans and gives a "turn-by-turn" feel.
  const { t: tt, lang } = useI18n();
  const [speaking, setSpeaking] = useState(false);
  useEffect(() => () => window.speechSynthesis?.cancel(), []);

  if (!result) {
    return (
      <div className="rounded-xl bg-slate-800/40 p-3 text-sm text-slate-400 ring-1 ring-white/5">
        Ask the navigator for a route. The deterministic engine will compute the fastest path and
        Gemini will explain why it won.
      </div>
    );
  }

  const badge = STATUS_LABEL[result.status] ?? { text: result.status, color: "#94a3b8" };
  const w = result.winner;
  const r = result.runnerUp;
  const rd = result.reasonData;

  // Deterministic forecast: when the winner gate is jammed, project the crowd
  // model forward to tell the fan whether waiting helps — independent of Gemini,
  // so it still shows if the LLM is unavailable (graceful degradation). Pure +
  // cheap, so no memoization needed.
  const waitRec = w ? gateWaitRecommendation(w, t, calmThreshold) : null;

  function toggleSpeak() {
    const synth = typeof window !== "undefined" ? window.speechSynthesis : null;
    if (!synth || !w) return;
    if (speaking) {
      synth.cancel();
      setSpeaking(false);
      return;
    }
    const steps = w.path.map(nodeLabel).join(", then ");
    const gatePct = w.gateCapacities[0] ? pct(w.gateCapacities[0].capacityPct) : "";
    const dest = nodeLabel(w.path[w.path.length - 1]);
    const text = `Route to ${dest}: go via ${steps}. ${w.totalDistance} meters, about ${w.totalWait} minutes wait${gatePct ? `, gate at ${gatePct}` : ""}.`;
    const u = new SpeechSynthesisUtterance(text);
    u.lang = lang === "es" ? "es-ES" : "en-US";
    u.onend = () => setSpeaking(false);
    synth.cancel();
    synth.speak(u);
    setSpeaking(true);
  }

  return (
    <div className="space-y-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span
          className="inline-flex items-center gap-2 rounded-full px-2.5 py-1 text-xs font-semibold ring-1"
          style={{
            color: badge.color,
            borderColor: `${badge.color}55`,
            background: `${badge.color}14`,
          }}
        >
          <span
            className="inline-block h-2 w-2 rounded-full"
            style={{ background: badge.color }}
          />
          {badge.text}
        </span>
        {result.closedGates.length > 0 && (
          <span className="text-xs text-rose-300">
            (closed: {result.closedGates.map(nodeLabel).join(", ")})
          </span>
        )}
      </div>

      {w && (
        <div className="rounded-xl bg-slate-800/50 p-3 ring-1 ring-teal-400/20">
          <div className="mb-2 font-medium text-teal-300">
            Recommended{rd.winnerGate ? ` via ${nodeLabel(rd.winnerGate)}` : ""}
          </div>
          {r && r.totalWait > w.totalWait && (
            <div className="mb-2.5 flex items-baseline gap-1.5 rounded-lg bg-teal-500/10 px-2.5 py-1.5 ring-1 ring-teal-400/25">
              <span className="font-mono text-lg font-bold text-teal-300">
                ~{Math.round(r.totalWait - w.totalWait)} min
              </span>
              <span className="text-xs text-teal-200/80">saved vs runner-up</span>
            </div>
          )}
          <div className="grid grid-cols-3 gap-2 text-slate-200">
            <Stat label="Walking" value={`${w.totalDistance} m`} />
            <Stat label="Est. wait" value={`${w.totalWait} min`} />
            <Stat
              label="Gate load"
              value={w.gateCapacities[0] ? pct(w.gateCapacities[0].capacityPct) : "—"}
            />
          </div>
          <div className="mt-2 text-xs text-slate-400">
            {w.path.map(nodeLabel).join(" → ")}
          </div>
          {winnerGateAccessible && photoUrl && (
            <a
              href={photoUrl}
              target="_blank"
              rel="noreferrer"
              className="mt-2 inline-block text-xs text-teal-300 hover:text-teal-200 underline"
            >
              🦽 View accessible entrance photo for {nodeLabel(winnerGate!)}
            </a>
          )}
          <button
            onClick={toggleSpeak}
            className="mt-2 inline-flex items-center gap-1 rounded-lg bg-slate-900/70 px-2.5 py-1 text-xs text-teal-300 ring-1 ring-white/10 transition-colors hover:ring-teal-400/60"
          >
            {speaking ? `⏹ ${tt("audio.stop")}` : `🔊 ${tt("audio.read")}`}
          </button>
          {waitRec && (
            <div className="mt-2 rounded-lg bg-sky-950/40 px-2.5 py-1.5 text-xs text-sky-200 ring-1 ring-sky-400/20">
              <span className="font-semibold text-sky-300">Forecast: </span>
              {waitRec.clearsAtMin !== undefined
                ? `expected to clear in ~${waitRec.clearsAtMin} min`
                : "not forecast to clear soon"}
              <div className="mt-0.5 text-sky-200/80">{waitRec.message}</div>
            </div>
          )}
        </div>
      )}

      {r && (
        <div className="rounded-xl bg-slate-800/30 p-3 ring-1 ring-white/5">
          <div className="mb-2 font-medium text-slate-300">
            Runner-up{rd.runnerUpGate ? ` via ${nodeLabel(rd.runnerUpGate)}` : ""}
          </div>
          <div className="grid grid-cols-3 gap-2 text-slate-300">
            <Stat label="Walking" value={`${r.totalDistance} m`} />
            <Stat label="Est. wait" value={`${r.totalWait} min`} />
            <Stat
              label="Gate load"
              value={r.gateCapacities[0] ? pct(r.gateCapacities[0].capacityPct) : "—"}
            />
          </div>
          {rd.waitDelta !== 0 && (
            <div className="mt-2 text-xs text-slate-400">
              Δ wait {rd.waitDelta > 0 ? "+" : ""}
              {rd.waitDelta} min · Δ distance {rd.distanceDelta > 0 ? "+" : ""}
              {rd.distanceDelta} m vs runner-up
            </div>
          )}
        </div>
      )}

      {result.status === "no_accessible_path" && result.referenceRoute && (() => {
        const block = result.referenceRoute!.segments.find((s) => !s.accessible);
        return (
          <div className="rounded-xl bg-rose-950/40 p-3 text-xs text-rose-200 ring-1 ring-rose-500/25">
            The only route to {nodeLabel(result.referenceRoute!.path.at(-1) ?? "the destination")} uses
            a non-accessible segment
            {block ? ` (${nodeLabel(block.from)} → ${nodeLabel(block.to)}, stairs)` : ""}, so no
            wheelchair-accessible path exists. The assistant says so honestly rather than fabricate one.
          </div>
        );
      })()}

      {rd.overCapacityGates.length > 0 && result.status !== "all_over_capacity" && (
        <div className="rounded-lg bg-amber-500/10 px-2.5 py-1.5 text-xs text-amber-300 ring-1 ring-amber-500/25">
          Jammed gates: {rd.overCapacityGates.map((g) => `${g.label} ${pct(g.capacityPct)}`).join(", ")}
        </div>
      )}

      {result.allGates && result.allGates.length > 2 && (
        <div className="text-xs text-slate-400">
          Other gates considered:{" "}
          {result.allGates
            .slice(2)
            .map((g) => `${g.label} (${pct(g.capacityPct)}, ${g.totalWait.toFixed(0)} min wait)`)
            .join(", ")}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-slate-900/40 px-2 py-1.5 ring-1 ring-white/5">
      <div className="text-[10px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className="font-mono text-slate-100">{value}</div>
    </div>
  );
}
