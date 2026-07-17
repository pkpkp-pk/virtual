# Deploy — XAI Stadium Navigator

**Primary path: Vercel Hobby (free, no card) + Firebase services.** Vercel runs
the Next.js app natively (frontend + the `/api/*` routes as Serverless Functions
on the free Hobby tier). Firebase provides Firestore, FCM, Auth, Remote Config,
App Check, Storage, and Analytics via env vars — so the Google-services axis is
covered without hosting the backend on Firebase.

Liveness comes from the deterministic `jitter(t)` clock (a pure function of
time), so **no scheduled writer is needed** — the map evolves on its own. On
Vercel Hobby, cron is daily-only, so proactive alerts (gate crossings, egress
phase) are detected **on-demand inside `/api/crowd`** on the client's 4s poll,
throttled to ~30s/instance.

> **Why not Firebase Hosting for the backend?** Firebase Spark can host a static
> site but **cannot run Cloud Functions** — even 1st-gen functions require the
> Cloud Build + Artifact Registry pipeline, which needs the Blaze plan. So a
> Firebase-hosted backend is Blaze-only. Vercel Hobby keeps the backend
> free/no-card; Firebase contributes the services (Firestore/FCM/Auth/RC/Storage/
> Analytics) via env vars instead.

The app runs fully without any cloud config (deterministic fallback), so you can
`npm run dev` immediately and the UI is still live.

---

## Vercel + Firebase services (primary)

### 1. Firebase console setup (one time)

1. Create a Firebase project on the **Spark** plan (free). Enable **Firestore,
   Authentication** (Anonymous + Email/Password), **Cloud Messaging**, **Remote
   Config**, **App Check** (reCAPTCHA v3), **Cloud Storage**, **Analytics**.
2. Add a **web app** → copy the `firebaseConfig` JSON (apiKey, authDomain,
   projectId, appId, messagingSenderId). Generate an **FCM web push VAPID** key
   pair (Project settings → Cloud Messaging → Web push). Download a **service
   account** key JSON (Project settings → Service accounts → Generate new key).
3. Deploy the Firestore security rules (the CLI is authed for `virtual-a0760`):
   ```bash
   npm i -g firebase-tools && firebase login && firebase use --add
   firebase deploy --only firestore --project=YOUR_PROJECT_ID
   ```
4. Edit `public/firebase-messaging-sw.js` and replace the `__FIREBASE_*__`
   placeholders with your web app's real config values (the service worker can't
   read `NEXT_PUBLIC_*` env, so these are baked in). FCM won't work until you do.
5. (Phase 5) Upload accessibility entrance photos to Storage at
   `accessibility/{nodeId}.jpg` (e.g. `accessibility/gate_b.jpg`).

### 2. Vercel deploy

1. Push the repo to GitHub; import at https://vercel.com/new (auto-detects Next.js).
2. Add env vars (Project → Settings → Environment Variables):
   - `GEMINI_API_KEY` = your Gemini key *(required for /api/chat)* — https://aistudio.google.com/apikey
   - `FIREBASE_PROJECT_ID` = your Firebase project id
   - `FIREBASE_CLIENT_EMAIL` = service account email
   - `FIREBASE_PRIVATE_KEY` = the service account private key, pasted with literal
     `\n` *(required on Vercel — Vercel doesn't provide ADC like Cloud Functions;
     the Admin SDK needs the key to auth to Firestore/FCM)*
   - `NEXT_PUBLIC_FIREBASE_CONFIG` = the web firebaseConfig JSON (include `messagingSenderId`)
   - `NEXT_PUBLIC_VAPID_KEY` = the FCM web push VAPID public key
   - *(optional)* `NEXT_PUBLIC_APPCHECK_RECAPTCHA_SITE_KEY`, `OPS_SECRET`, `SIM_CRON_SECRET`
3. Deploy. Every `git push` redeploys.

### 3. Enabling Phases 2–6 (console + env)

- **Auth + ticket binding (P2):** enable Authentication (Anonymous + Email/Password).
  The client signs in anonymously and writes a `users/{uid}` profile (owner-only).
  FCM re-registers to `gate_{ticketGate}` for personalized pushes; chat pre-fills origin.
- **Remote Config (P3):** create keys `overCapacityThreshold` (0.9), `calmThreshold`
  (0.7), `forecastHorizonMin` (15). Server reads them with a 60s cache; tune per-match
  without redeploy. Pathfinder threshold stays code-defined.
- **App Check (P4):** register reCAPTCHA v3, set `NEXT_PUBLIC_APPCHECK_RECAPTCHA_SITE_KEY`,
  enforce on Firestore/Functions in the console. Keep unset in dev.
- **Accessibility photos (P5):** upload to Storage `accessibility/{nodeId}.jpg`; the
  XAI panel shows a "View accessible entrance photo" link for the accessible winner gate.
- **Analytics + organizer view (P6):** enable Analytics (client logs `route_requested`,
  `egress_routed`, `gate_alert_dismissed`, `ticket_bound`). Set `OPS_SECRET` and open
  `/ops` — a read-only organizer dashboard (live gate loads, request aggregates, alerts).

### How liveness + alerts work (no scheduler)

- **Occupancy** is computed from `jitter(t)` on every read — never persisted to
  Firestore (that would be circular). The map evolves every second with no writes.
- **Firestore** carries only shared state: `gates/closed`, `gateState/latest`,
  `events/{id}`, `users/{uid}`, `stats/{gateId}`. Clients read `events` +
  `gates/closed` via `onSnapshot` with **offline persistence**.
- **Alerts:** `/api/crowd` runs detection on a ~30s/instance throttle — on an
  upward crossing or arrival→egress flip it writes an `events` doc and sends an
  FCM push to `gate_{id}` + `global` topics. Pushes arrive backgrounded.
- `POST /api/sim/tick` (with `X-Cron-Secret`) is a manual force-detect for demos.

### Quota notes

Vercel Hobby: generous serverless execution + 100GB bandwidth. `/api/crowd` runs
per poll per user — lengthen the poll to ~8–10s (`useCrowdState(8000)`) for real
traffic. Firebase Spark: 20k Firestore writes/day, 50k reads/day — event/stats
writes are rare (only on crossings), well within limits.

> Verify after deploy: open the URL → header shows `live · jitter · arrival`
> evolving, map recolors on its own; run an example prompt → explanation cites
> real capacity/wait numbers; push a gate over 90% → an `events` doc appears, the
> banner shows it, an FCM push arrives (background the tab); toggle a gate closed
> → persists in `gates/closed` across restarts. Log results in `PROMPT_LOG.md`.

---

## Local dev

```bash
cp .env.example .env.local   # fill GEMINI_API_KEY + the Firebase vars
npm install
npm run dev                  # http://localhost:3000
npm test                     # deterministic-core + events + api/guard tests
npm run demo:edges           # edge-case demo (no keys needed)
npm run sim:tick             # one-off: run the alert cycle + hotspots
```

Without `GEMINI_API_KEY`, `/api/chat` returns a clear 500 (or a degraded
fallback); everything else (map, crowd, gate controls, alerts, edge cases) works
on the deterministic fallback.
