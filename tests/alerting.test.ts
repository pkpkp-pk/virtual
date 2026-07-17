import { describe, it, expect, vi, beforeEach } from "vitest";
import { runAlertCycle } from "@/lib/alerting";
import { occupancyAtTime, NODE_MAP } from "@/lib/graph/stadiumGraph";
import type { GateStateDoc } from "@/lib/events";

// Mock the Firebase admin module so we can exercise the alert orchestrator's
// resilience contract without a real Firestore/FCM: FCM send failures must not
// roll back the event write or the gateState baseline; Firestore failures must
// be swallowed so the crowd response never breaks.

const mocks = vi.hoisted(() => ({
  firebaseConfigured: vi.fn(),
  readGateState: vi.fn(),
  writeGateState: vi.fn(),
  addEvent: vi.fn(),
  sendEventNotifications: vi.fn(),
}));

vi.mock("@/lib/firebase/admin", () => ({
  firebaseConfigured: mocks.firebaseConfigured,
  readGateState: mocks.readGateState,
  writeGateState: mocks.writeGateState,
  addEvent: mocks.addEvent,
  sendEventNotifications: mocks.sendEventNotifications,
}));

const NOW = 1_000_000;
const stateWithGateCOver = () => ({
  ...occupancyAtTime(0),
  gate_c: NODE_MAP["gate_c"].capacity, // 100% -> over threshold
});
const prevGateCUnder = (over = false): GateStateDoc => ({
  gates: { gate_c: { over, pct: over ? 0.95 : 0.5 } },
  phase: "arrival",
  updatedAt: NOW - 60_000,
});

beforeEach(() => {
  mocks.firebaseConfigured.mockReset();
  mocks.readGateState.mockReset();
  mocks.writeGateState.mockReset();
  mocks.addEvent.mockReset();
  mocks.sendEventNotifications.mockReset();
  mocks.firebaseConfigured.mockReturnValue(true);
  mocks.writeGateState.mockResolvedValue(undefined);
  mocks.addEvent.mockResolvedValue(undefined);
  mocks.sendEventNotifications.mockResolvedValue(undefined);
});

describe("runAlertCycle", () => {
  it("is a no-op when Firebase isn't configured", async () => {
    mocks.firebaseConfigured.mockReturnValue(false);
    const events = await runAlertCycle(stateWithGateCOver(), "arrival", NOW);
    expect(events).toEqual([]);
    expect(mocks.readGateState).not.toHaveBeenCalled();
    expect(mocks.writeGateState).not.toHaveBeenCalled();
  });

  it("detects an upward crossing, records the event, writes baseline, pushes FCM", async () => {
    mocks.readGateState.mockResolvedValue(prevGateCUnder(false));
    const events = await runAlertCycle(stateWithGateCOver(), "arrival", NOW);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("gate_crossing");
    expect(events[0].gateId).toBe("gate_c");
    expect(mocks.addEvent).toHaveBeenCalledTimes(1);
    expect(mocks.writeGateState).toHaveBeenCalledTimes(1);
    expect(mocks.sendEventNotifications).toHaveBeenCalledTimes(1);
  });

  it("FCM send failure does NOT skip the gateState write (best-effort push)", async () => {
    mocks.readGateState.mockResolvedValue(prevGateCUnder(false));
    mocks.sendEventNotifications.mockRejectedValue(new Error("FCM down"));
    const events = await runAlertCycle(stateWithGateCOver(), "arrival", NOW);
    // Event still recorded + baseline still written — FCM is isolated.
    expect(events).toHaveLength(1);
    expect(mocks.addEvent).toHaveBeenCalledTimes(1);
    expect(mocks.writeGateState).toHaveBeenCalledTimes(1);
  });

  it("Firestore readGateState failure is swallowed (returns [], no writes)", async () => {
    mocks.readGateState.mockRejectedValue(new Error("firestore down"));
    const events = await runAlertCycle(stateWithGateCOver(), "arrival", NOW);
    expect(events).toEqual([]);
    expect(mocks.addEvent).not.toHaveBeenCalled();
    expect(mocks.writeGateState).not.toHaveBeenCalled();
    expect(mocks.sendEventNotifications).not.toHaveBeenCalled();
  });

  it("no crossing -> no events, but the baseline is still refreshed", async () => {
    // gate_c calm in both prev and current.
    mocks.readGateState.mockResolvedValue(prevGateCUnder(false));
    const calm = { ...occupancyAtTime(0), gate_c: 10 };
    const events = await runAlertCycle(calm, "arrival", NOW);
    expect(events).toEqual([]);
    expect(mocks.addEvent).not.toHaveBeenCalled();
    expect(mocks.sendEventNotifications).not.toHaveBeenCalled();
    expect(mocks.writeGateState).toHaveBeenCalledTimes(1);
  });

  it("first poll (prev=null) -> no gate crossings (cold-start no-burst), baseline written", async () => {
    mocks.readGateState.mockResolvedValue(null);
    const events = await runAlertCycle(stateWithGateCOver(), "arrival", NOW);
    expect(events).toEqual([]);
    expect(mocks.addEvent).not.toHaveBeenCalled();
    expect(mocks.sendEventNotifications).not.toHaveBeenCalled();
    expect(mocks.writeGateState).toHaveBeenCalledTimes(1);
  });
});
