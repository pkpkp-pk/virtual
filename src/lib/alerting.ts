// Alert orchestrator: one place that turns the current occupancy + phase into
// detected events, persists them to Firestore, and fires FCM pushes. Called from
// the throttled path of /api/crowd (on-demand, no scheduler) and from the manual
// /api/sim/tick. Best-effort: failures are logged and swallowed so the crowd
// response never breaks.
//
// Resilience contract (pinned by tests/alerting.test.ts):
//  - addEvent + writeGateState are the authoritative record; an FCM push failure
//    must NOT roll them back or skip the gateState write (otherwise the next poll
//    re-detects the same crossing and duplicates the event).
//  - Any Firestore/FCM error is swallowed and the cycle returns what it detected.

import {
  computeGateStatuses,
  detectCrossings,
  type CrowdEvent,
  type GateStateDoc,
} from "./events";
import {
  firebaseConfigured,
  readGateState,
  writeGateState,
  addEvent,
  sendEventNotifications,
} from "./firebase/admin";
import type { OccupancyState } from "./types";
import type { ScenarioPhase } from "./graph/jitter";

export async function runAlertCycle(
  state: OccupancyState,
  phase: ScenarioPhase,
  now: number,
  threshold?: number
): Promise<CrowdEvent[]> {
  if (!firebaseConfigured()) return [];
  try {
    const prev = await readGateState();
    const curGates = computeGateStatuses(state, threshold);
    const events = detectCrossings(prev, curGates, phase, now);

    // Authoritative record first: persist every detected event + update the
    // baseline. These MUST succeed for the cycle to count (a thrown error here
    // bubbles to the outer catch and the cycle is retried next poll).
    if (events.length > 0) {
      for (const e of events) {
        await addEvent(e);
      }
    }
    const doc: GateStateDoc = { gates: curGates, phase, updatedAt: now };
    await writeGateState(doc);

    // FCM is best-effort and isolated: a push failure must not roll back the
    // event write or the gateState baseline (which would cause duplicate
    // events on the next poll). Just log and carry on.
    if (events.length > 0) {
      try {
        await sendEventNotifications(events);
      } catch (err) {
        console.warn("[alerting] FCM send failed (events still recorded):", err);
      }
    }

    return events;
  } catch (err) {
    console.warn("[alerting] cycle failed:", err);
    return [];
  }
}
