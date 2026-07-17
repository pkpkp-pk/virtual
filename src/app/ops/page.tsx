"use client";

import { useState } from "react";
import type { CrowdEvent } from "@/lib/events";

interface GateLoad {
  id: string;
  label: string;
  occupancy: number;
  capacityPct: number;
  over: boolean;
}
interface TopGate {
  gateId: string;
  label: string;
  count: number;
  lastAt: number;
}
interface OpsData {
  phase: string;
  t: number;
  closedGates: string[];
  gateLoads: GateLoad[];
  topGates: TopGate[];
  recentEvents: CrowdEvent[];
  source: string;
}

/** Read-only organizer dashboard: live gate loads + phase, top requested gates,
 *  and the recent alert feed. Protected by the OPS_SECRET header when set. */
export default function OpsPage() {
  const [secret, setSecret] = useState("");
  const [data, setData] = useState<OpsData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/ops", {
        headers: { "x-ops-secret": secret },
        cache: "no-store",
      });
      if (!res.ok) {
        setError(`Error ${res.status}: ${await res.text()}`);
        return;
      }
      setData(await res.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="mx-auto max-w-5xl p-4 lg:p-6">
      <header className="mb-4">
        <h1 className="text-xl font-bold text-slate-100">Stadium Ops — organizer view</h1>
        <p className="text-xs text-slate-400">
          Live gate loads, request aggregates, and the alert feed. Read-only.
        </p>
      </header>

      <div className="mb-4 flex gap-2">
        <input
          type="password"
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          placeholder="Ops secret (if OPS_SECRET is set)"
          className="flex-1 rounded-lg bg-slate-900 px-3 py-2 text-sm text-slate-100 ring-1 ring-slate-700 outline-none focus:ring-teal-400"
        />
        <button
          onClick={load}
          disabled={loading}
          className="rounded-lg bg-teal-500 px-4 py-2 text-sm font-semibold text-slate-900 disabled:opacity-40"
        >
          {loading ? "Loading…" : "Load"}
        </button>
      </div>

      {error && <div className="mb-4 rounded-lg bg-rose-950/40 p-3 text-sm text-rose-200">{error}</div>}

      {data && (
        <div className="space-y-6">
          <div className="flex flex-wrap gap-4 text-sm text-slate-300">
            <span>
              Phase: <strong className="text-slate-100">{data.phase}</strong>
            </span>
            <span>t = {Math.round(data.t)}s</span>
            <span>source = {data.source}</span>
            {data.closedGates.length > 0 && (
              <span className="text-rose-300">closed: {data.closedGates.join(", ")}</span>
            )}
          </div>

          <section>
            <h2 className="mb-2 text-sm font-semibold text-slate-200">Live gate loads</h2>
            <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
              {data.gateLoads.map((g) => (
                <div
                  key={g.id}
                  className={`rounded-lg p-3 ring-1 ${
                    g.over
                      ? "bg-rose-950/40 ring-rose-500/40"
                      : "bg-slate-900 ring-slate-800"
                  }`}
                >
                  <div className="text-sm font-medium text-slate-100">{g.label}</div>
                  <div className="text-xs text-slate-400">
                    {Math.round(g.capacityPct * 100)}% · {g.occupancy} ppl
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section>
            <h2 className="mb-2 text-sm font-semibold text-slate-200">Most-requested gates</h2>
            {data.topGates.length === 0 ? (
              <p className="text-xs text-slate-500">No route requests logged yet.</p>
            ) : (
              <ol className="space-y-1 text-sm text-slate-300">
                {data.topGates.map((g, i) => (
                  <li key={g.gateId}>
                    {i + 1}. {g.label} — <strong>{g.count}</strong> requests
                  </li>
                ))}
              </ol>
            )}
          </section>

          <section>
            <h2 className="mb-2 text-sm font-semibold text-slate-200">Recent alerts</h2>
            {data.recentEvents.length === 0 ? (
              <p className="text-xs text-slate-500">No events detected yet.</p>
            ) : (
              <ul className="space-y-1 text-sm text-slate-300">
                {data.recentEvents.map((e, i) => (
                  <li key={i} className="text-xs">
                    <span className="text-slate-500">
                      {new Date(e.at).toLocaleTimeString()}
                    </span>{" "}
                    {e.message}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </main>
  );
}
