# Prompt-Evolution Log

Running log of key prompts, decisions, and screenshots — the raw material for the
mandatory LinkedIn post. Add entries as the build evolves (don't scramble on the
last night). One entry per meaningful change.

## Format

```
### YYYY-MM-DD — <short title>
- What changed / what we tried
- Key prompt(s) used (system or user) — paste verbatim or summarize
- Outcome / what the model did well or poorly
- Decision & rationale
- Screenshot: <path or description>
```

---

### 2026-07-16 — Initial system prompt (XAI translation layer)

- **Change:** First system prompt for the Gemini tool-use layer (`src/lib/gemini/client.ts`).
- **Key prompt (system):**
  > You are the XAI Stadium Navigator assistant for MetLife Stadium… You do NOT
  > compute routes or distances. A deterministic pathfinding tool (find_route)
  > does all the math. Your job is to (1) understand the user's request in any
  > language, resolve their origin and destination to node ids, and call
  > find_route; then (2) explain the result honestly using the exact numbers the
  > tool returns. NEVER invent, round loosely, or guess capacity, wait time, or
  > distance — cite the tool's numbers.
  - Plus per-status guidance (ok / all_over_capacity / no_accessible_path / no_path)
    and the full node catalog.
- **Decision:** One callable tool (`find_route`); the explanation is the model's
  final text, grounded in the structured result. No `explain_decision` tool —
  that concept is realized via the prompt, not a second function call.
- **Rationale:** Keeps the tool surface minimal and idiomatic; the model can't
  "compute" an explanation because it never gets asked to — it only reads numbers.
- **To verify:** Once a `GEMINI_API_KEY` is set, run the example prompts through
  the chat panel and record whether the explanation cites the real capacity/wait
  figures (not invented ones), and whether mixed-language input resolves.

---

### 2026-07-17 — Depth pass: deterministic access, forecasting, egress, rendezvous, resilience

- **Change:** A tiered set of improvements that deepen the existing fan + navigation
  thesis (no new persona, no seat-level rebuild) and reuse the deterministic engine:
  - **Deterministic accessibility (worst-case-reviewer fix).** The "Wheelchair-accessible
    route" checkbox used to string-concatenate a phrase into the query and rely on
    Gemini inferring `accessible: true`. Now `accessible` is a structured field in the
    `/api/chat` body and is **forced** onto the `find_route` tool call via a pure
    `applyForcedAccess(args, forced)` helper — the model's inference for that one
    parameter is bypassed entirely. Unit-tested without a Gemini call.
  - **Crowd forecasting (real-time decision support, the centerpiece).** `jitter(t)` is
    a pure function of time, so the future is nearly free: new `forecast.ts` samples a
    node's load at `t + Δ` and finds when a jammed gate drops below the calm threshold.
    New `forecast_crowd` tool + a deterministic "expected to clear in ~N min" line in
    the XAI panel. The "wait 4 min — Gate C drops 91%→68%" story.
  - **Multi-turn history** (follow-ups like "what about the accessible one?" now work),
    **live threshold-crossing banner** ("⚠ Gate C just crossed 90%") on the existing
    4s poll, **per-IP rate limit + 30s response cache** keyed on `(query, accessible,
    bucket30)` on `/api/chat` (cost-optimization story), and **graceful degradation**:
    if Gemini errors mid-loop after a route was computed, return it with a fallback note
    instead of crashing — the deterministic XAI panel renders independently of the LLM.
  - **Post-match egress mode + a small transportation layer.** New `transit` node type
    (`nj_transit`, `parking_east`, `rideshare_dropoff`) and a second crowd phase: after
    kickoff the model inverts — sections depopulate, gates/concourses/exits/transit take
    an egress-crush boost (a Gaussian centered post-kickoff). The same `find_route`
    answers "fastest way out to NJ Transit." Phase shown in the header.
  - **Group rendezvous.** New `find_rendezvous` entry point: single-source Dijkstra from
    each start, score every amenity/concourse by combined travel cost × crowd multiplier.
    New `find_rendezvous` tool. "Where do we meet that isn't a crush?"
  - **Polish:** the pathfinder already ranked every gate internally — now `allGates` is
    surfaced ("Gate D was also considered but 15% more crowded"); confidence framing in
    the prompt ("currently ~91%", "expected to"); one-line sustainability nudge noting
    NJ Transit as the lower-footprint option when it's part of the answer.
- **Key prompt additions (system):** a FORECASTING clause ("call forecast_crowd when a
  gate is over capacity, cite the projected figures"), a GROUP RENDEZVOUS clause, an
  EGRESS/LEAVING resolution rule (transit node ids), CONFIDENCE FRAMING, a SUSTAINABILITY
  NUDGE, and a "mention consideredGates" addition to the ok-status guidance. Tool surface
  grew from 1 to 3 (`find_route`, `forecast_crowd`, `find_rendezvous`).
- **Decision:** forecasting/egress/rendezvous all live in the deterministic `lib/graph/`
  layer (pure functions of t / inputs) and are unit-tested there — the LLM only calls
  tools and explains. This preserves the locked "math vs language" separation and the
  "engineering mindset over fancy model" rubric language. `occupancyAt` (arrival) was
  left untouched so existing tests stay green; a phase-aware `nodeOccupancyAt` composer
  is the single source of truth for both the live snapshot and the forecast.
- **Rationale:** Every item reuses the existing engine (Dijkstra, jitter, the XAI panel)
  rather than rebuilding — depth over coverage. Forecasting was prioritized over the
  "missing" list because the math already existed. Egress deepens the "real problem"
  claim (egress crush is the more dangerous crowd problem). Resilience (rate limit,
  cache, degradation) is a concrete cost/resilience story for demo day.
- **Verify status:** 56 unit tests green (was 24), lint clean, `next build` green. Gemini
  e2e still pending a `GEMINI_API_KEY` runtime test (as before).
- **Screenshot:** TODO on deploy — capture the forecast line, the threshold banner, the
  egress-phase header + NJ Transit route, and a rendezvous answer.

---

### 2026-07-17 — Firebase Spark migration + full Spark-allowed feature set

- **Change:** Migrated the deploy target to **Firebase Spark (free, no card)** and
  added the full set of Spark-eligible improvements. Hard constraint: no Cloud Run,
  Cloud Scheduler, Vertex AI/Genkit, or App Hosting (all need Blaze).
- **Architecture shift (fixes the circular-Firestore problem):** occupancy is NEVER
  persisted — `jitter(t)` computes it on every read. Firestore now stores only
  genuinely-shared state: `gates/closed`, `gateState/latest`, `events/{id}`,
  `users/{uid}`, `stats/routes/{gate}`. `firestore.rules` rewritten.
- **Liveness without a scheduler:** the client polls `/api/crowd` every 4s; on a
  ~30s/instance throttle the route runs the alert-detection cycle (pure
  `computeGateStatuses` + `detectCrossings` in `src/lib/events.ts`, orchestrated by
  `src/lib/alerting.ts`) — on an upward gate crossing or arrival→egress flip it
  writes an `events` doc and sends an FCM topic push (`gate_{id}` + `global`). Every
  fan sees the same alert; pushes arrive backgrounded.
- **Phases shipped (all Spark-free):**
  - P1 alerts core: FCM push, server `events` feed (replaces per-client detection),
    Firestore offline persistence (`persistentLocalCache`) for spotty stadium
    cellular, `/api/fcm/register` topic subscription, `firebase-messaging-sw.js`.
  - P2: Firebase Auth (anonymous) + ticket binding (`users/{uid}`, owner-only) →
    personalized "your gate" FCM + chat origin pre-fill.
  - P3: Remote Config thresholds (server-side, 60s cache) drive alerting + forecast
    display; pathfinder threshold stays code-defined.
  - P4: App Check (reCAPTCHA v3) client attestation, env-gated; console enforcement.
  - P5: Cloud Storage accessibility entrance photos surfaced in the XAI panel.
  - P6: Analytics events (`route_requested`, `egress_routed`, etc.) + a read-only
    `/ops` organizer dashboard (live loads, request aggregates, alert feed).
- **Deploy:** framework-aware Firebase Hosting (`firebase deploy --only
  hosting,firestore`) → Next.js SSR + API routes on Cloud Functions 2nd gen. Env:
  `GEMINI_API_KEY`, Firebase Admin (service account or ADC — admin.ts falls back to
  ADC when the private key is empty, which is what Cloud Functions runtime provides),
  `NEXT_PUBLIC_FIREBASE_CONFIG`, `NEXT_PUBLIC_VAPID_KEY`, optional App Check +
  `OPS_SECRET`. `firebase-tools` is a devDep; `npm run deploy` / `npm run emulators`.
- **Decision:** all Firebase features are wired so the app still runs fully on the
  deterministic fallback when Firebase isn't configured (dev) — each product is
  opt-in via env. The "no scheduler" constraint made on-demand event detection
  (piggybacking the poll) the honest liveness story and removed the old circular
  tick-writer.
- **Verify status:** 66 unit tests green (added `events.test.ts`), lint clean, `next
  build` green (routes now include `/api/fcm/register`, `/api/ops`, `/ops`). Firestore
  rules deployed to `virtual-a0760`. Hosting deploy + full e2e pending the user's
  Phase 0 (web config, VAPID, SW placeholders) + `firebase deploy`. Note: project
  mismatch surfaced — CLI is authed for `virtual-a0760` but `.env.local` had
  `virtual-d2467`; deploy targets a0760.
- **Screenshot:** TODO on deploy — capture the alert banner, push notification, /ops
  dashboard, and the accessible-entrance photo link.

---

### 2026-07-17 — Deploy outcome: Firebase Spark can't host a backend → Vercel + Firebase

- **Tried:** Firebase Spark deploy of the full stack. Framework-aware Hosting
  needs the `webframeworks` experiment + `firebase-frameworks` (peer-dep capped
  `firebase-admin@^13`, fixed with `.npmrc` `legacy-peer-deps`) + Cloud Functions
  2nd gen (needs Blaze). Pivoted to static export + 1st-gen Cloud Functions
  (`functions/` package, `output:"export"`, `firebase.json` rewrites `/api/*` →
  functions). Static hosting + firestore rules deployed fine to `virtual-a0760`
  (live at https://virtual-a0760.web.app). But `firebase deploy --only functions`
  failed: **even 1st-gen Cloud Functions require the Cloud Build + Artifact
  Registry pipeline → Blaze plan required.**
- **Finding:** Firebase Spark can host a static site but **cannot run any server
  backend**. Strict-Spark + Firebase-hosted backend is impossible.
- **Decision:** Deploy on **Vercel Hobby (free, no card) + Firebase services**
  (Firestore/FCM/Auth/Remote Config/App Check/Storage/Analytics via env vars).
  Reverted the static-export refactor — restored the Next API routes
  (`/api/{chat,crowd,sim/gates,sim/tick,fcm/register,ops}`) so Vercel runs the
  app natively; `next.config.ts` back to `output:"standalone"` + `turbopack.root`.
  The `functions/` package stays as the Firebase-Blaze alternate path. Firestore
  rules remain deployed to `virtual-a0760`.
- **Key Vercel caveat:** Vercel doesn't provide ADC like Cloud Functions, so
  `FIREBASE_PRIVATE_KEY` (service account key) is **required** there for the
  Admin SDK to auth to Firestore/FCM — the ADC fallback that works in Cloud
  Functions doesn't apply.
- **Verify status:** 66 tests, lint, `next build` all green with the API routes
  restored. Vercel deploy + full e2e pending the user's env vars on Vercel.

---

### 2026-07-17 — Coverage gap fix, resilience hardening, persona/framing discipline

- **Critique addressed:** the new Firebase layer (FCM alerting, ticket-bound
  auth, /ops aggregation, 3-tool Gemini loop, rate limiting, caching) had zero
  coverage while growing bigger than the original 24-test core — the
  highest-risk item under "testing worst-case scenarios."
- **Tests added (66 → 102):**
  - `chatGuard.test.ts` — rate-limit cap/reset + per-IP isolation + cache key
    (query/accessible/bucket) + short-TTL behavior.
  - `alerting.test.ts` — mock-admin: crossing detection + writes; **FCM send
    failure does not roll back the event write or gateState baseline**; Firestore
    failure swallowed; cold-start no-burst; no-crossing baseline refresh.
  - `toolDispatch.test.ts` — extracted pure `dispatchToolCall`: 3-tool dispatch,
    forced accessibility overriding the model, node-resolution failures,
    unknown-tool handling.
  - `apiRoutes.test.ts` — `/api/fcm/register` validation, `/api/ops` +
    `/api/sim/tick` secret gating, `/api/chat` rate-limit + cache + multi-turn
    bypass.
- **Resilience fix:** `alerting.ts` now isolates the FCM send in its own
  try/catch (was: a single try that aborted the gateState write on push failure,
  which would re-detect + duplicate the event next poll). Pinned by a test.
- **Refactor:** extracted `dispatchToolCall` from the Gemini loop so the per-call
  logic is pure and testable without a Gemini call.
- **Persona discipline:** README rewritten to lead unambiguously with the **fan**
  experience; `/ops` is explicitly framed as a small *secondary proof point* that
  the same engine generalizes — not a co-equal feature (avoids the "spread thin
  across personas" penalty).
- **Firebase service justification:** README now has a one-line "why each"
  table (Firestore = shared state, FCM = the proactive-alert feature, Auth =
  personalization, Remote Config = no-redeploy operator tuning, Storage =
  accessibility photos, App Check = abuse/cost-control paired with the rate
  limiter, Analytics = organizer insights) — deliberate, not checkbox-collecting.
- **Stale deploy cleaned:** `firebase hosting:disable` on `virtual-a0760.web.app`
  (the static Firebase Hosting site can't be deleted — it's the default site —
  but disabling returns 404 so the backend-less leftover is no longer reachable).
- **Verify status:** 102 tests, lint, `next build` green. Pushed to GitHub;
  Vercel auto-redeploys.

---

<!-- Add future entries below. -->
