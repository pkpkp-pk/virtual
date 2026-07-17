import { describe, it, expect } from "vitest";
import {
  computeGateStatuses,
  detectCrossings,
  type GateStateDoc,
} from "@/lib/events";
import { occupancyAtTime, NODE_MAP } from "@/lib/graph/stadiumGraph";
import { OVER_CAPACITY_THRESHOLD } from "@/lib/graph/jitter";
import type { ScenarioPhase } from "@/lib/graph/jitter";

// Pure event-detection logic (no Firestore, no FCM). Tests the threshold-
// crossing + phase-flip math that the crowd route runs on a throttled cadence.

describe("computeGateStatuses", () => {
  it("returns an entry only for gate nodes", () => {
    const s = computeGateStatuses(occupancyAtTime(0));
    for (const id of Object.keys(s)) {
      expect(NODE_MAP[id].type).toBe("gate");
    }
    expect(Object.keys(s).length).toBeGreaterThan(0);
  });

  it("flags a gate over the threshold", () => {
    const state = occupancyAtTime(0);
    state.gate_c = NODE_MAP["gate_c"].capacity; // 100% -> over
    const s = computeGateStatuses(state);
    expect(s["gate_c"].over).toBe(true);
    expect(s["gate_c"].pct).toBeGreaterThanOrEqual(OVER_CAPACITY_THRESHOLD);
  });

  it("leaves a calm gate under the threshold", () => {
    const state = occupancyAtTime(0);
    state.gate_d = 10;
    const s = computeGateStatuses(state);
    expect(s["gate_d"].over).toBe(false);
  });
});

describe("detectCrossings", () => {
  const now = 1_000_000;

  function gateState(
    gates: Record<string, { over: boolean; pct: number }>,
    phase: ScenarioPhase = "arrival"
  ): GateStateDoc {
    return { gates, phase, updatedAt: now - 60_000 };
  }

  it("emits a gate_crossing event on an UPWARD crossing", () => {
    const prev = gateState({ gate_c: { over: false, pct: 0.5 } });
    const cur = computeGateStatuses({ gate_c: NODE_MAP["gate_c"].capacity });
    const events = detectCrossings(prev, cur, "arrival", now);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("gate_crossing");
    expect(events[0].gateId).toBe("gate_c");
    expect(events[0].message).toMatch(/%/);
  });

  it("emits NO event on a downward crossing (jam clearing)", () => {
    const prev = gateState({ gate_c: { over: true, pct: 0.95 } });
    const cur = computeGateStatuses({ gate_c: 10 });
    const events = detectCrossings(prev, cur, "arrival", now);
    expect(events).toEqual([]);
  });

  it("emits no event when the gate stays over (no re-cross)", () => {
    const prev = gateState({ gate_c: { over: true, pct: 0.95 } });
    const cur = computeGateStatuses({ gate_c: NODE_MAP["gate_c"].capacity });
    expect(detectCrossings(prev, cur, "arrival", now)).toEqual([]);
  });

  it("emits a phase_change event on arrival -> egress", () => {
    const prev = gateState({}, "arrival");
    const events = detectCrossings(prev, computeGateStatuses({}), "egress", now);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("phase_change");
    expect(events[0].phase).toBe("egress");
    expect(events[0].message).toMatch(/egress/i);
  });

  it("emits both a gate crossing and a phase change if both flip at once", () => {
    const prev = gateState({ gate_d: { over: false, pct: 0.5 } }, "arrival");
    const cur = computeGateStatuses({ gate_d: NODE_MAP["gate_d"].capacity });
    const events = detectCrossings(prev, cur, "egress", now);
    expect(events).toHaveLength(2);
    expect(events.some((e) => e.type === "gate_crossing")).toBe(true);
    expect(events.some((e) => e.type === "phase_change")).toBe(true);
  });

  it("emits nothing when there is no prior state (first poll)", () => {
    const cur = computeGateStatuses({ gate_c: NODE_MAP["gate_c"].capacity });
    // prev = null: no gate crossings (nothing to compare), no phase flip.
    expect(detectCrossings(null, cur, "arrival", now)).toEqual([]);
  });

  it("uses the caller-supplied `now` (pure — no Date.now)", () => {
    const prev = gateState({ gate_c: { over: false, pct: 0.5 } });
    const cur = computeGateStatuses({ gate_c: NODE_MAP["gate_c"].capacity });
    const a = detectCrossings(prev, cur, "arrival", 111);
    const b = detectCrossings(prev, cur, "arrival", 222);
    expect(a[0].at).toBe(111);
    expect(b[0].at).toBe(222);
  });
});
