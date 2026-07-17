"use client";

import { useEffect, useRef, useState } from "react";
import {
  clientConfigured,
  subscribeEvents,
  getAnalyticsClient,
} from "@/lib/firebase/client";
import { NODE_LIST } from "@/lib/graph/stadiumGraph";
import { OVER_CAPACITY_THRESHOLD } from "@/lib/graph/jitter";
import type { CrowdEvent } from "@/lib/events";
import type { OccupancyState } from "@/lib/types";
import type { ScenarioPhase } from "@/lib/graph/jitter";

const GATES = NODE_LIST.filter((n) => n.type === "gate");
const ALERT_TTL_MS = 15_000;
const MAX_ALERTS = 5;

/** Unified alert shape for the banner (server-authored events when Firebase is
 *  configured, client-detected as a dev fallback otherwise). */
export interface Alert {
  key: string;
  message: string;
  label?: string;
  gateId?: string;
  pct?: number;
  at: number; // epoch ms
}

export interface CrowdThresholds {
  overCapacityThreshold: number;
  calmThreshold: number;
  forecastHorizonMin: number;
}

export interface CrowdState {
  state: OccupancyState;
  closedGates: string[];
  source: string;
  t: number;
  phase: ScenarioPhase;
  alerts: Alert[];
  thresholds?: CrowdThresholds;
}

function eventKey(e: CrowdEvent): string {
  return `e-${e.at}-${e.gateId ?? e.phase ?? e.type}`;
}

function eventToAlert(e: CrowdEvent): Alert {
  return {
    key: eventKey(e),
    message: e.message,
    label: e.gateLabel,
    gateId: e.gateId,
    pct: e.pct,
    at: e.at,
  };
}

/** Live crowd state. Polls /api/crowd (occupancy + phase + closedGates, evolving
 *  via jitter with no scheduler) and, when Firebase is configured, subscribes to
 *  the server-authored `events` feed for proactive alerts shared by all fans.
 *  Falls back to client-side threshold detection in dev (no Firebase). */
export function useCrowdState(intervalMs = 4000): CrowdState {
  const [crowd, setCrowd] = useState<CrowdState>({
    state: {},
    closedGates: [],
    source: "loading",
    t: 0,
    phase: "arrival",
    alerts: [],
  });
  const prevOcc = useRef<Record<string, number>>({});
  const alertSeq = useRef(0);

  useEffect(() => {
    let unsub: (() => void) | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;

    // Server-authored alerts (preferred): subscribe to the events feed.
    if (clientConfigured()) {
      unsub = subscribeEvents((events) => {
        const now = Date.now();
        const alerts = events
          .map(eventToAlert)
          .filter((a) => now - a.at < ALERT_TTL_MS)
          .slice(0, MAX_ALERTS);
        setCrowd((prev) => ({ ...prev, alerts }));
      });
      // Best-effort analytics (Phase 6); ignore failures.
      getAnalyticsClient().catch(() => {});
    }

    // Client-side alert detection (dev fallback when Firebase isn't configured).
    const detectClientAlerts = (
      prev: CrowdState,
      next: {
        state: OccupancyState;
        closedGates: string[];
        source: string;
        t: number;
        phase: ScenarioPhase;
        thresholds?: CrowdThresholds;
      }
    ): Alert[] => {
      if (clientConfigured()) return prev.alerts; // server feed owns alerts
      const threshold = next.thresholds?.overCapacityThreshold ?? OVER_CAPACITY_THRESHOLD;
      const now = Date.now();
      const newAlerts: Alert[] = [];
      for (const g of GATES) {
        const before = prevOcc.current[g.id] ?? 0;
        const after = next.state[g.id] ?? 0;
        const beforePct = before / g.capacity;
        const afterPct = after / g.capacity;
        if (beforePct < threshold && afterPct >= threshold) {
          alertSeq.current += 1;
          newAlerts.push({
            key: `c-${alertSeq.current}`,
            label: g.label,
            gateId: g.id,
            pct: afterPct,
            at: now,
            message: `${g.label} just crossed ${Math.round(afterPct * 100)}% capacity — expect delays.`,
          });
        }
        prevOcc.current[g.id] = after;
      }
      const fresh = (prev.alerts ?? []).filter((a) => now - a.at < ALERT_TTL_MS);
      return [...newAlerts, ...fresh].slice(0, MAX_ALERTS);
    };

    const applyPoll = (j: {
      nodes: Array<{ id: string; occupancy: number }>;
      closedGates?: string[];
      source?: string;
      t?: number;
      phase?: ScenarioPhase;
      thresholds?: CrowdThresholds;
    }) => {
      const state: OccupancyState = {};
      for (const n of j.nodes) {
        state[n.id] = n.occupancy;
      }
      setCrowd((prev) => {
        const next = {
          state,
          closedGates: j.closedGates ?? [],
          source: j.source ?? "jitter",
          t: j.t ?? prev.t,
          phase: (j.phase as ScenarioPhase) ?? prev.phase,
          thresholds: j.thresholds ?? prev.thresholds,
        };
        return { ...next, alerts: detectClientAlerts(prev, next) };
      });
    };

    const poll = async () => {
      try {
        const r = await fetch("/api/crowd", { cache: "no-store" });
        if (!r.ok) return;
        applyPoll(await r.json());
      } catch {
        /* keep last good state */
      }
    };
    poll();
    timer = setInterval(poll, intervalMs);

    return () => {
      unsub?.();
      if (timer) clearInterval(timer);
    };
  }, [intervalMs]);

  return crowd;
}
