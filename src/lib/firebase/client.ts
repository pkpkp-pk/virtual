// Browser Firebase client. Active only when NEXT_PUBLIC_FIREBASE_CONFIG (or the
// individual NEXT_PUBLIC_ vars) is set; otherwise the UI falls back to polling
// /api/crowd (which still returns time-based jitter values that evolve on their
// own) and client-side alert detection.
//
// Responsibilities:
//  - Firestore with OFFLINE PERSISTENCE — the crowd state + events cache locally
//    so the app keeps working on spotty stadium cellular (a real WC problem).
//  - subscribeEvents: onSnapshot on the `events` feed → server-authored alerts
//    shared by all fans (replaces per-client threshold detection).
//  - FCM: request a web-push token + register it for topic subscriptions.
//  - Lazy getters for Auth / Storage / Analytics (used by later phases).

import { getApp, getApps, initializeApp, type FirebaseApp } from "firebase/app";
import {
  getFirestore,
  initializeFirestore,
  persistentLocalCache,
  onSnapshot,
  collection,
  query,
  orderBy,
  limit,
  type Firestore,
} from "firebase/firestore";
import {
  getMessaging,
  getToken,
  isSupported as messagingIsSupported,
  type Messaging,
} from "firebase/messaging";
import { getAuth, type Auth } from "firebase/auth";
import { getStorage, type FirebaseStorage } from "firebase/storage";
import {
  getAnalytics,
  isSupported as analyticsIsSupported,
  type Analytics,
} from "firebase/analytics";
import {
  initializeAppCheck,
  ReCaptchaV3Provider,
  type AppCheck,
} from "firebase/app-check";
import type { CrowdEvent } from "../events";

export interface ClientConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  appId?: string;
  messagingSenderId?: string;
}

let app: FirebaseApp | null = null;
let firestore: Firestore | null = null;
let auth: Auth | null = null;
let messaging: Messaging | null = null;
let storage: FirebaseStorage | null = null;
let analytics: Analytics | null = null;
let appCheck: AppCheck | null = null;

export function clientConfigured(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_FIREBASE_CONFIG || process.env.NEXT_PUBLIC_FB_PROJECT_ID
  );
}

/** Parse the browser config from env. Returns the full config object (permissive
 *  — extra fields like messagingSenderId are passed through to initializeApp). */
function loadConfig(): Record<string, string> | null {
  const raw = process.env.NEXT_PUBLIC_FIREBASE_CONFIG;
  if (raw) {
    try {
      return JSON.parse(raw) as Record<string, string>;
    } catch {
      return null;
    }
  }
  const projectId = process.env.NEXT_PUBLIC_FB_PROJECT_ID;
  if (projectId) {
    return {
      apiKey: process.env.NEXT_PUBLIC_FB_API_KEY ?? "",
      authDomain: `${projectId}.firebaseapp.com`,
      projectId,
      appId: process.env.NEXT_PUBLIC_FB_APP_ID ?? "",
    };
  }
  return null;
}

function getAppInstance(): FirebaseApp | null {
  const cfg = loadConfig();
  if (!cfg) return null;
  if (!app) {
    app = getApps().length ? getApp() : initializeApp(cfg);
    // App Check (Phase 4): activate reCAPTCHA v3 attestation when a site key is
    // configured, so Firestore/Functions requests carry an App Check token. Dev
    // without the key skips it (enforcement is set in the Firebase console).
    maybeInitAppCheck(app);
  }
  return app;
}

function maybeInitAppCheck(a: FirebaseApp): void {
  if (appCheck) return;
  const siteKey = process.env.NEXT_PUBLIC_APPCHECK_RECAPTCHA_SITE_KEY;
  if (!siteKey) return;
  try {
    appCheck = initializeAppCheck(a, {
      provider: new ReCaptchaV3Provider(siteKey),
      isTokenAutoRefreshEnabled: true,
    });
  } catch (err) {
    console.warn("[appcheck] init failed:", err);
  }
}

function getFs(): Firestore | null {
  if (firestore) return firestore;
  const a = getAppInstance();
  if (!a) return null;
  try {
    // Offline persistence: cache Firestore locally so the app survives network
    // dropouts (common at a packed stadium). initializeFirestore must run before
    // any getFirestore use on this app.
    firestore = initializeFirestore(a, {
      // Offline persistence: cache Firestore locally so the app survives
      // network dropouts (common at a packed stadium). Defaults to a
      // single-tab manager, which is correct for this single-page app.
      localCache: persistentLocalCache({}),
    });
  } catch {
    // Already initialized for this app — fall back to the shared instance.
    firestore = getFirestore(a);
  }
  return firestore;
}

/** Public accessor for the Firestore instance (used by auth/profile helpers). */
export function getFirestoreClient(): Firestore | null {
  return getFs();
}

/** Subscribe to the server-authored alert feed (last 5 events). Returns an
 *  unsubscribe fn, or null if Firebase isn't configured. */
export function subscribeEvents(
  cb: (events: CrowdEvent[]) => void
): (() => void) | null {
  const fs = getFs();
  if (!fs) return null;
  const q = query(collection(fs, "events"), orderBy("at", "desc"), limit(5));
  return onSnapshot(
    q,
    (snap) => {
      const events: CrowdEvent[] = [];
      snap.forEach((d) => events.push(d.data() as CrowdEvent));
      cb(events);
    },
    (err) => console.warn("[subscribeEvents]", err)
  );
}

// --- FCM (web push) ---------------------------------------------------------

/** Request an FCM registration token (triggers the permission prompt). Requires
 *  NEXT_PUBLIC_VAPID_KEY + the firebase-messaging-sw.js service worker. Returns
 *  null if unsupported/unconfigured/permission denied. */
export async function requestFCMToken(): Promise<string | null> {
  const a = getAppInstance();
  if (!a) return null;
  if (!(await messagingIsSupported())) return null;
  if (!messaging) messaging = getMessaging(a);
  const vapidKey = process.env.NEXT_PUBLIC_VAPID_KEY;
  try {
    const token = await getToken(messaging, vapidKey ? { vapidKey } : undefined);
    return token || null;
  } catch (err) {
    console.warn("[fcm] getToken failed:", err);
    return null;
  }
}

/** Register an FCM token for topic subscriptions (global + the fan's gate). */
export async function registerFCM(
  token: string,
  gateId?: string
): Promise<boolean> {
  try {
    const res = await fetch("/api/fcm/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, gateId }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// --- Lazy getters for later phases ------------------------------------------

export function getAuthClient(): Auth | null {
  if (auth) return auth;
  const a = getAppInstance();
  if (!a) return null;
  auth = getAuth(a);
  return auth;
}

export function getStorageClient(): FirebaseStorage | null {
  if (storage) return storage;
  const a = getAppInstance();
  if (!a) return null;
  storage = getStorage(a);
  return storage;
}

export async function getAnalyticsClient(): Promise<Analytics | null> {
  if (analytics) return analytics;
  const a = getAppInstance();
  if (!a) return null;
  if (!(await analyticsIsSupported())) return null;
  analytics = getAnalytics(a);
  return analytics;
}
