"use client";

import { useEffect, useRef, useState } from "react";
import StadiumMap from "./components/StadiumMap";
import ChatPanel from "./components/ChatPanel";
import RouteExplanation from "./components/RouteExplanation";
import TicketBinder from "./components/TicketBinder";
import { useCrowdState } from "./hooks/useCrowdState";
import { useAuthProfile } from "./hooks/useAuthProfile";
import { useChat } from "./hooks/useChat";
import { I18nProvider, useI18n, LANGS, LANG_LABEL, type Lang } from "@/lib/i18n";
import { NODE_LIST, nodeLabel } from "@/lib/graph/stadiumGraph";
import {
  clientConfigured,
  requestFCMToken,
  registerFCM,
} from "@/lib/firebase/client";
import { logAnalytics } from "@/lib/firebase/analytics";
import type { PathfinderResult } from "@/lib/types";
import type { TicketProfile } from "@/lib/firebase/profile";

const GATES = NODE_LIST.filter((n) => n.type === "gate");

function HomeInner() {
  const { t, lang, setLang } = useI18n();
  const crowd = useCrowdState();
  const auth = useAuthProfile();
  const [routeResult, setRouteResult] = useState<PathfinderResult | null>(null);
  const [busyGates, setBusyGates] = useState(false);
  const [dismissedAlerts, setDismissedAlerts] = useState<Set<string>>(new Set());
  const [notifStatus, setNotifStatus] = useState<"off" | "on" | "denied">("off");
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const fcmTokenRef = useRef<string | null>(null);

  const boundOrigin = auth.profile?.ticketSection
    ? nodeLabel(auth.profile.ticketSection)
    : auth.profile?.ticketGate
    ? nodeLabel(auth.profile.ticketGate)
    : undefined;
  const boundNodeId = auth.profile?.ticketSection ?? auth.profile?.ticketGate ?? null;
  const visibleAlerts = crowd.alerts.filter((a) => !dismissedAlerts.has(a.key));
  const alertGateIds = crowd.alerts
    .map((a) => a.gateId)
    .filter((x): x is string => !!x);

  function handleRouteResult(r: PathfinderResult | null) {
    setRouteResult(r);
    const gate = r?.winner?.gateCapacities[0]?.id;
    if (gate) {
      logAnalytics("route_requested", {
        gate,
        from: r?.winner?.path[0],
        to: r?.winner?.path.at(-1),
      });
      if (crowd.phase === "egress") logAnalytics("egress_routed", { gate });
    }
  }
  const chat = useChat({ onRouteResult: handleRouteResult, boundOrigin });

  async function handleBind(p: TicketProfile) {
    await auth.bind(p);
    logAnalytics("ticket_bound", { gate: p.ticketGate, section: p.ticketSection });
  }

  async function toggleGate(gateId: string, close: boolean) {
    const next = new Set(crowd.closedGates);
    if (close) next.add(gateId);
    else next.delete(gateId);
    setBusyGates(true);
    try {
      await fetch("/api/sim/gates", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ closedGates: Array.from(next) }),
      });
    } finally {
      setBusyGates(false);
    }
  }

  const hotGates = GATES.map((g) => ({
    id: g.id,
    label: g.label,
    pct: (crowd.state[g.id] ?? 0) / g.capacity,
  }))
    .filter((g) => g.pct >= 0.9)
    .sort((a, b) => b.pct - a.pct);

  // FCM push permission + topic registration.
  useEffect(() => {
    if (!clientConfigured() || !process.env.NEXT_PUBLIC_VAPID_KEY) return;
    let cancelled = false;
    (async () => {
      const token = await requestFCMToken();
      if (cancelled) return;
      if (!token) {
        setNotifStatus("denied");
        return;
      }
      fcmTokenRef.current = token;
      const ok = await registerFCM(token, auth.profile?.ticketGate);
      if (!cancelled) setNotifStatus(ok ? "on" : "denied");
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const token = fcmTokenRef.current;
    const gate = auth.profile?.ticketGate;
    if (token && gate) registerFCM(token, gate).catch(() => {});
  }, [auth.profile?.ticketGate]);

  // Map → chat actions.
  const onRouteTo = (id: string) => {
    chat.send(`Fastest route to ${nodeLabel(id)}`);
    setSelectedNodeId(null);
  };
  const onRouteFrom = (id: string) => {
    const dest = auth.profile?.ticketSection
      ? nodeLabel(auth.profile.ticketSection)
      : "Section 126";
    chat.send(`Fastest route from ${nodeLabel(id)} to ${dest}`);
    setSelectedNodeId(null);
  };

  return (
    <main className="mx-auto flex min-h-screen max-w-7xl flex-col gap-4 p-4 lg:p-6">
      <header className="card relative flex flex-wrap items-center justify-between gap-3 overflow-hidden px-4 py-3.5">
        {/* Top gradient accent line. */}
        <div
          className="absolute inset-x-0 top-0 h-px"
          style={{ background: "var(--brand)" }}
          aria-hidden
        />
        <div className="flex items-center gap-3">
          {/* Stadium glyph */}
          <div
            className="grid h-11 w-11 shrink-0 place-items-center rounded-xl shadow-lg ring-1 ring-white/15"
            style={{ background: "var(--brand)" }}
            aria-hidden
          >
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
              <path
                d="M3 10c2.5-1.2 6-2 9-2s6.5.8 9 2v8H3v-8z"
                fill="#04121a"
                opacity={0.9}
              />
              <path d="M3 10c2.5-1.2 6-2 9-2s6.5.8 9 2" stroke="#04121a" strokeWidth={1.4} opacity={0.5} />
              <circle cx="12" cy="9.4" r="1.5" fill="#04121a" />
            </svg>
          </div>
          <div>
            <h1 className="text-xl font-bold leading-tight tracking-tight">
              <span className="brand-text">XAI Stadium Navigator</span>
              <span className="text-slate-500"> · MetLife</span>
            </h1>
            <p className="text-xs text-slate-400">{t("header.subtitle")}</p>
          </div>
        </div>
        <div className="flex items-center gap-2 text-xs text-slate-400">
          <span className="pill">
            <span
              className={`inline-block h-2 w-2 rounded-full live-dot ${
                crowd.source === "firestore"
                  ? "bg-emerald-400"
                  : crowd.source === "jitter"
                  ? "bg-sky-400"
                  : "bg-slate-500"
              }`}
            />
            {crowd.source === "loading"
              ? "connecting…"
              : `live · ${crowd.source} · ${crowd.phase} · t=${Math.round(crowd.t)}s`}
          </span>
          {notifStatus === "on" && (
            <span className="pill border-emerald-500/30 text-emerald-300">🔔 push on</span>
          )}
          {/* Language picker */}
          <div className="flex rounded-lg ring-1 ring-white/10">
            {LANGS.map((l: Lang) => (
              <button
                key={l}
                onClick={() => setLang(l)}
                className={`px-2.5 py-1 text-[11px] transition-colors ${
                  lang === l
                    ? "bg-teal-400/90 font-semibold text-slate-900"
                    : "text-slate-300 hover:text-teal-300"
                } ${l === LANGS[0] ? "rounded-l-lg" : "rounded-r-lg"}`}
                aria-label={LANG_LABEL[l]}
              >
                {l.toUpperCase()}
              </button>
            ))}
          </div>
        </div>
      </header>

      {visibleAlerts.length > 0 && (
        <div className="space-y-2">
          {visibleAlerts.map((a) => (
            <button
              key={a.key}
              onClick={() => a.gateId && setSelectedNodeId(a.gateId)}
              className="card card-hover flex w-full items-center justify-between gap-3 border-amber-500/40 bg-amber-500/10 px-3 py-2 text-left text-sm text-amber-200 hover:border-amber-400/70"
            >
              <span>⚠ {a.message}</span>
              <span
                onClick={(e) => {
                  e.stopPropagation();
                  setDismissedAlerts((prev) => new Set(prev).add(a.key));
                  logAnalytics("gate_alert_dismissed", { key: a.key });
                }}
                className="shrink-0 rounded-md px-1.5 text-xs text-amber-300/80 hover:bg-amber-500/15 hover:text-amber-100"
                aria-label="Dismiss alert"
              >
                ✕
              </span>
            </button>
          ))}
        </div>
      )}

      <div className="grid flex-1 grid-cols-1 gap-4 lg:grid-cols-[1.4fr_1fr]">
        {/* Map + controls */}
        <section className="flex flex-col gap-3">
          <div className="card overflow-hidden p-2">
            <div className="aspect-[1000/680] w-full">
              <StadiumMap
                occupancy={crowd.state}
                closedGates={crowd.closedGates}
                routeResult={routeResult}
                selectedId={selectedNodeId}
                onNodeSelect={setSelectedNodeId}
                boundNodeId={boundNodeId}
                alertGateIds={alertGateIds}
                onRouteTo={onRouteTo}
                onRouteFrom={onRouteFrom}
              />
            </div>
          </div>

          <div className="card hidden p-3 lg:block">
            <div className="mb-2.5 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-200">{t("section.controls")}</h2>
              {hotGates.length > 0 && (
                <span className="text-xs text-amber-300">
                  Jammed: {hotGates.map((g) => `${g.label} ${Math.round(g.pct * 100)}%`).join(", ")}
                </span>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              {GATES.map((g) => {
                const closed = crowd.closedGates.includes(g.id);
                const pct = (crowd.state[g.id] ?? 0) / g.capacity;
                return (
                  <button
                    key={g.id}
                    onClick={() => toggleGate(g.id, !closed)}
                    disabled={busyGates}
                    className={`rounded-lg px-3 py-1.5 text-xs font-medium ring-1 transition-colors ${
                      closed
                        ? "bg-rose-600/30 text-rose-200 ring-rose-500/50"
                        : pct >= 0.9
                        ? "bg-amber-500/20 text-amber-200 ring-amber-500/40 hover:ring-amber-400"
                        : "bg-slate-800/70 text-slate-300 ring-white/10 hover:ring-teal-400/70"
                    }`}
                  >
                    {g.label} {closed ? "✕ closed" : `· ${Math.round(pct * 100)}%`}
                  </button>
                );
              })}
            </div>
          </div>
        </section>

        {/* Ticket + XAI + chat (chat is a bottom sheet on mobile) */}
        <section className="flex flex-col gap-3">
          {clientConfigured() && auth.ready && (
            <div className="card p-3">
              <h2 className="mb-2 text-sm font-semibold text-slate-200">{t("section.ticket")}</h2>
              <TicketBinder bound={auth.profile} onBind={handleBind} />
            </div>
          )}
          <div className="card p-3">
            <h2 className="mb-2 text-sm font-semibold text-slate-200">{t("section.xai")}</h2>
            <RouteExplanation
              result={routeResult}
              t={crowd.t}
              calmThreshold={crowd.thresholds?.calmThreshold}
            />
          </div>
          <div className="card fixed inset-x-0 bottom-0 z-30 flex max-h-[48vh] min-h-[360px] flex-1 flex-col overflow-y-auto rounded-t-2xl p-3 lg:static lg:max-h-[360px] lg:overflow-visible lg:rounded-2xl">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-200">{t("section.navigator")}</h2>
              <span className="h-1 w-8 rounded-full bg-slate-600 lg:hidden" />
            </div>
            <ChatPanel chat={chat} />
          </div>
        </section>
      </div>

      {/* Spacer so the mobile bottom sheet doesn't cover content. */}
      <div className="h-[48vh] lg:hidden" aria-hidden />
    </main>
  );
}

export default function Home() {
  return (
    <I18nProvider>
      <HomeInner />
    </I18nProvider>
  );
}
