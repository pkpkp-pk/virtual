// Firebase Admin SDK (server-side): Firestore for shared demo state (gate
// closures, gate-status for crossing detection, the events feed) + FCM for push
// alerts. Gracefully no-ops when Firebase isn't configured (dev falls back to
// deterministic jitter + in-memory gate state).
//
// IMPORTANT: occupancy is NOT persisted. It is computed from the pure jitter(t)
// model on every read, so Firestore only carries genuinely-shared state that
// jitter alone can't produce — gate closures, detected events, per-gate status,
// user profiles. This is what makes the Firestore usage non-circular.
//
// firebase-admin v14 uses modular subpath imports.

import { initializeApp, cert, getApps, type App, type ServiceAccount } from "firebase-admin/app";
import { getFirestore, type Firestore, FieldValue } from "firebase-admin/firestore";
import { getMessaging, type Messaging } from "firebase-admin/messaging";
import { getRemoteConfig, type RemoteConfig } from "firebase-admin/remote-config";
import type { CrowdEvent, GateStateDoc } from "../events";

let app: App | null = null;
let messaging: Messaging | null = null;
let remoteConfig: RemoteConfig | null = null;

export function firebaseConfigured(): boolean {
  return Boolean(
    process.env.FIREBASE_PROJECT_ID &&
      (process.env.FIREBASE_CLIENT_EMAIL || process.env.GOOGLE_APPLICATION_CREDENTIALS) &&
      (process.env.FIREBASE_PRIVATE_KEY || process.env.GOOGLE_APPLICATION_CREDENTIALS)
  );
}

function getApp(): App {
  if (app) return app;
  if (getApps().length) {
    app = getApps()[0]!;
    return app;
  }
  // Use Application Default Credentials when GOOGLE_APPLICATION_CREDENTIALS is
  // set OR no service-account private key was provided. In Cloud Functions the
  // runtime supplies ADC (the function's service account), so no key is needed
  // — and a missing/empty key must not crash initialization.
  const useAdc =
    Boolean(process.env.GOOGLE_APPLICATION_CREDENTIALS) ||
    !process.env.FIREBASE_PRIVATE_KEY;
  if (useAdc) {
    app = initializeApp({ projectId: process.env.FIREBASE_PROJECT_ID });
  } else {
    const sa: ServiceAccount = {
      projectId: process.env.FIREBASE_PROJECT_ID!,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL!,
      privateKey: process.env.FIREBASE_PRIVATE_KEY!.replace(/\\n/g, "\n"),
    };
    app = initializeApp({ credential: cert(sa), projectId: sa.projectId });
  }
  return app;
}

function db(): Firestore {
  return getFirestore(getApp());
}

function msg(): Messaging {
  if (!messaging) messaging = getMessaging(getApp());
  return messaging;
}

// --- Remote Config (operator-tunable thresholds, no redeploy) ---------------

export interface Thresholds {
  /** Gate load (0..1) at/above which a gate is "over capacity" for alerts. */
  overCapacityThreshold: number;
  /** Gate load below which a jammed gate counts as "calm" in a forecast. */
  calmThreshold: number;
  /** Minutes ahead the forecast projects. */
  forecastHorizonMin: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  overCapacityThreshold: 0.9,
  calmThreshold: 0.7,
  forecastHorizonMin: 15,
};

let thresholdsCache: Thresholds | null = null;
let thresholdsCacheAt = 0;
const RC_TTL_MS = 60_000;

/** Fetch operator-tunable thresholds from Remote Config, with a 60s in-memory
 *  cache. Falls back to defaults if Firebase isn't configured or the fetch
 *  fails — alerting must never break because RC was unreachable. */
export async function getThresholds(): Promise<Thresholds> {
  if (!firebaseConfigured()) return DEFAULT_THRESHOLDS;
  const now = Date.now();
  if (thresholdsCache && now - thresholdsCacheAt < RC_TTL_MS) return thresholdsCache;
  try {
    if (!remoteConfig) remoteConfig = getRemoteConfig(getApp());
    const tmpl = await remoteConfig.getTemplate();
    const get = (k: string, dflt: number): number => {
      const dv = tmpl.parameters[k]?.defaultValue as { value?: string } | undefined;
      const v = dv?.value;
      return v ? Number(v) || dflt : dflt;
    };
    thresholdsCache = {
      overCapacityThreshold: get("overCapacityThreshold", DEFAULT_THRESHOLDS.overCapacityThreshold),
      calmThreshold: get("calmThreshold", DEFAULT_THRESHOLDS.calmThreshold),
      forecastHorizonMin: get("forecastHorizonMin", DEFAULT_THRESHOLDS.forecastHorizonMin),
    };
    thresholdsCacheAt = now;
    return thresholdsCache;
  } catch (err) {
    console.warn("[remoteconfig] fetch failed, using defaults:", err);
    return DEFAULT_THRESHOLDS;
  }
}

// --- Firestore document locations -------------------------------------------

const CLOSED_DOC = "gates/closed"; // { closedGates: string[], updatedAt }
const GATESTATE_DOC = "gateState/latest"; // GateStateDoc
const EVENTS_COL = "events"; // append-only CrowdEvent docs

// --- Gate closures ----------------------------------------------------------

interface ClosedDoc {
  closedGates?: string[];
}

export async function readClosedGates(): Promise<string[]> {
  const snap = await db().doc(CLOSED_DOC).get();
  const d = snap.data() as ClosedDoc | undefined;
  return d?.closedGates ?? [];
}

export async function writeClosedGates(closedGates: string[]): Promise<void> {
  await db().doc(CLOSED_DOC).set({ closedGates, updatedAt: Date.now() });
}

// --- Gate state (for crossing detection) ------------------------------------

export async function readGateState(): Promise<GateStateDoc | null> {
  const snap = await db().doc(GATESTATE_DOC).get();
  if (!snap.exists) return null;
  return snap.data() as GateStateDoc;
}

/** Merge the new gate status into `gateState/latest` (preserves concurrent fields). */
export async function writeGateState(state: GateStateDoc): Promise<void> {
  await db().doc(GATESTATE_DOC).set(state, { merge: true });
}

// --- Events feed ------------------------------------------------------------

/** Append a detected event. Firestore generates the id. */
export async function addEvent(event: CrowdEvent): Promise<void> {
  await db().collection(EVENTS_COL).add({ ...event, at: event.at });
}

// --- Stats (Phase 6 organizer view) -----------------------------------------

/** Increment the request counter for a gate (best-effort). */
export async function incrementRouteStat(gateId: string): Promise<void> {
  try {
    // `stats/{gateId}` — one doc per gate (2 path segments = a valid doc path).
    await db().doc(`stats/${gateId}`).set(
      { count: FieldValue.increment(1), lastAt: Date.now() },
      { merge: true }
    );
  } catch (err) {
    console.warn("[stats] increment failed:", err);
  }
}

export interface RouteStat {
  gateId: string;
  count: number;
  lastAt: number;
}

/** Read all per-gate route-request aggregates, sorted by count desc. */
export async function readRouteStats(): Promise<RouteStat[]> {
  const snap = await db().collection("stats").get();
  const out: RouteStat[] = [];
  snap.forEach((d) => {
    const data = d.data() as { count?: number; lastAt?: number };
    out.push({ gateId: d.id, count: data.count ?? 0, lastAt: data.lastAt ?? 0 });
  });
  return out.sort((a, b) => b.count - a.count);
}

/** Read the most recent events (newest first). */
export async function readRecentEvents(limitN = 20): Promise<CrowdEvent[]> {
  const snap = await db()
    .collection(EVENTS_COL)
    .orderBy("at", "desc")
    .limit(limitN)
    .get();
  const out: CrowdEvent[] = [];
  snap.forEach((d) => out.push(d.data() as CrowdEvent));
  return out;
}

// --- FCM --------------------------------------------------------------------

/** Subscribe one or more FCM registration tokens to a topic. */
export async function subscribeToTopic(
  tokens: string[],
  topic: string
): Promise<void> {
  if (tokens.length === 0) return;
  await msg().subscribeToTopic(tokens, topic);
}

/** Send push notifications for a batch of detected events to the relevant topics.
 *  Best-effort: a push failure must not break the crowd response. */
export async function sendEventNotifications(events: CrowdEvent[]): Promise<void> {
  for (const e of events) {
    const notification = {
      title:
        e.type === "gate_crossing" ? `${e.gateLabel} is jammed` : "Traffic shift",
      body: e.message,
    };
    const topics = e.type === "gate_crossing" && e.gateId
      ? [`gate_${e.gateId}`, "global"]
      : ["global"];
    for (const topic of topics) {
      try {
        await msg().send({ topic, notification });
      } catch (err) {
        console.warn(`[fcm] send to ${topic} failed:`, err);
      }
    }
  }
}
