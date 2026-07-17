# XAI Crowd-Aware Stadium Navigator — MetLife

An **Explainable AI** wayfinder that tells a fan the *fastest route to their
seat right now*, accounting for live gate congestion — and **explains why** that
route won, in plain language, with real numbers. Built for the FIFA World Cup
2026 at MetLife Stadium.

> **One persona, gone deep: the fan.** The product is the fan experience —
> navigation, live crowd, accessibility, forecasting, egress, rendezvous, and
> proactive alerts. The `/ops` organizer view exists only as a small secondary
> proof that the *same* deterministic engine generalizes to a second audience,
> not as a co-equal feature.

> **Core philosophy: separate math from language.** A deterministic graph
> pathfinder (Dijkstra) does all the spatial/cost computation. Gemini does only
> what LLMs are good at — translating free-form, any-language intent into
> structured params, and turning the computed result into a multilingual
> explanation. The LLM never does geometry, and can't hallucinate numbers
> because it only reads the tool's output. A **Gemini Flash** model explains
> already-computed data — the cheap model is the *correct* choice, not a
> compromise.

## Why this is a real problem, not a chatbot

"Where's the nearest gate" is a FAQ. "Which route gets me to my seat fastest
*right now*, given which gates are jammed" is a genuine **weighted-graph
optimization** with live-changing edge weights and hard accessibility
constraints. The LLM is the interface and the explainer; the decision-making
core is deterministic, unit-tested code.

## What the fan gets

- **Natural-language routing** in any language → fastest crowd-aware route to a
  seat/amenity/gate, with winner-vs-runner-up reasoning citing real numbers.
- **Live crowd heat-map** that evolves on its own — no scheduler, no static pages.
- **Wheelchair-accessible routing** — deterministic (the flag is *forced* into
  the tool call, never inferred by the LLM), with honest "no accessible path"
  failures that name the blocking stairs.
- **Crowd forecasting** — "wait 4 min, Gate C drops 91%→68%" (projects the pure
  `jitter(t)` model forward).
- **Post-match egress mode** — "fastest way out to NJ Transit"; a second crowd
  phase where exits jam and seats depopulate (egress crush is the more dangerous
  real-world problem).
- **Group rendezvous** — "my friend's at Gate B, I'm at Gate D, where do we meet
  that isn't a crush?"
- **Proactive push alerts** — FCM to a backgrounded phone when a gate crosses
  90% or traffic flips to egress; personalized to *your* gate via ticket binding.
- **Multilingual** — Gemini responds in the fan's language and resolves
  garbled/mixed-language input.

*Secondary proof point:* `/ops` — a read-only organizer dashboard (live gate
loads, most-requested gates, alert feed) showing the engine generalizes beyond
the fan. It is deliberately small and not the headline.

## Architecture

```
User (free-form, any language)
  → Gemini (tool-use): resolves intent → calls find_route / forecast_crowd / find_rendezvous
  → deterministic core executes the tool (Dijkstra / jitter-projection / multi-start search)
  → Gemini: turns the structured result → multilingual XAI explanation
  → Frontend: SVG stadium map + the "Why this route?" panel + proactive alerts
```

**Deploy:** Vercel Hobby (frontend + `/api/*` as serverless functions, $0/no-card)
+ Firebase services (Firestore/FCM/Auth/Remote Config/Storage/Analytics/App
Check) via env vars. Vercel computes and serves; Firebase is the real-time
data + engagement layer.

## Live, not static (no scheduler)

`jitter(t) = base + amplitude·sin(2πt/period + phase) + kickoffDrift(t) +
egressBoost(t)` is a **pure function of wall-clock time**, so occupancy evolves
every second with **zero writes**. Cloud Scheduler isn't used (and isn't
available on Spark / Vercel Hobby cron is daily-only). Proactive alert
detection (gate crossings, arrival→egress phase flips) piggybacks **on-demand**
on the client's 4s `/api/crowd` poll, throttled to ~30s/instance — the honest
scheduler-free liveness story.

**Non-circular Firestore:** occupancy is *never* persisted (jitter computes it
on read). Firestore stores only genuinely-shared state jitter can't produce —
the alert feed, gate-closure persistence, per-gate stats, ticket profiles.

## The layers

1. **Deterministic core** (`src/lib/graph`) — `stadiumGraph` (~24 nodes incl.
   transit), `pathfinder` (Dijkstra + per-gate ranking + accessible filter +
   full `allGates` ranking + `dijkstraAllFrom` for rendezvous), `jitter`
   (occupancy(t) + crowdMultiplier + egressPhase/egressBoost), `forecast`
   (projects jitter forward), `rendezvous` (multi-start meeting spot). Pure,
   no LLM/Firebase.
2. **Events/alerting** (`src/lib/events.ts` pure `detectCrossings` +
   `computeGateStatuses`; `src/lib/alerting.ts` orchestrator with best-effort
   FCM so a push failure can't roll back the event write).
3. **XAI layer** (`src/lib/gemini`) — 3 tools (`find_route`, `forecast_crowd`,
   `find_rendezvous`); `dispatchToolCall` is extracted pure logic; `applyForcedAccess`
   forces accessibility deterministically.
4. **API routes** (`src/app/api`, Vercel serverless) — `/api/chat` (Gemini +
   rate-limit/cache + stats), `/api/crowd` (jitter + throttled detection + FCM),
   `/api/sim/gates`, `/api/sim/tick` (manual), `/api/fcm/register`, `/api/ops`.
5. **Firebase** (`src/lib/firebase`) — Admin SDK (Firestore/FCM/Remote Config/
   stats) + browser SDK (offline persistence, events onSnapshot, FCM token,
   Auth/Storage/Analytics/App Check).
6. **Frontend** (`src/app`) — SVG map, chat (multi-turn + accessible + bound
   origin), deterministic XAI panel (route stats + forecast line + gate ranking
   + accessible-photo link), ticket binder, alert banner.

## Firebase services — why each (not checkbox-collecting)

| Service | One-line justification |
|---|---|
| **Firestore** | Shared state jitter can't produce: alert `events` feed, `gates/closed` persistence, `gateState` baseline, `users/{uid}` profiles, `stats/{gate}`. Occupancy is NOT stored (non-circular). |
| **FCM** | The proactive-alert channel — pushes to backgrounded phones on gate crossings/phase flips (the feature doesn't exist without it). |
| **Auth** | Anonymous uid → ticket binding → personalized "your gate" alerts + remembered seat. |
| **Remote Config** | Operators tune the 90% threshold / forecast horizon per-match **without redeploying**. |
| **Cloud Storage** | Accessibility entrance photos — accessibility beyond a boolean flag. |
| **App Check** | Abuse prevention / cost control — pairs with the `/api/chat` rate limiter to keep the Gemini endpoint from being hammered. |
| **Analytics** | Aggregated fan-behavior insights for the organizer view (which gates/sections get requested, egress peaks). |

## Edge cases (handled + demoed)

Run `npm run demo:edges` (no API keys needed):

| Case | Behavior |
|---|---|
| All gates over capacity | `all_over_capacity` — least-bad route, lists every jammed gate's %/wait, recommends wait vs detour |
| No accessible path | `no_accessible_path` — says so honestly, names the blocking stairs, never fabricates |
| Gate closes mid-session | live recalculation excluding that gate; persists in `gates/closed` across restarts |
| Garbled / mixed-language | Gemini resolves it ("¿sección 126 accesible?" → `find_route(sec_126, accessible=true)`) |
| Gemini API failure | graceful degradation — deterministic route + panel still render with a "live explanation unavailable" note |

## Resilience (tested)

102 tests cover the deterministic core **and** the new layer's failure modes:
FCM send failure doesn't roll back the event write; Firestore failures are
swallowed so `/api/crowd` never breaks; the rate limiter caps abuse; the cache
is short-lived; forced accessibility overrides the model; node-resolution
failures return structured errors. See `tests/` (`jitter`, `pathfinder`,
`edge-cases`, `forced-access`, `forecast`, `egress`, `rendezvous`, `events`,
`chatGuard`, `alerting`, `toolDispatch`, `apiRoutes`).

## Stack

Next.js 16 (App Router, TS) · React 19 · Tailwind · Gemini 2.5 Flash
(`@google/genai`) · Firebase (Admin + JS SDK) · Vercel Hobby · Vitest (**102
tests**). Runs entirely on free tiers — no credits, no card.

## Run

```bash
cp .env.example .env.local   # fill GEMINI_API_KEY (min) + Firebase vars for full features
npm install
npm run dev                  # http://localhost:3000
npm test                     # 102 tests
npm run demo:edges           # edge-case demo, no keys needed
```

Without `GEMINI_API_KEY`, `/api/chat` degrades gracefully; the map, crowd,
gate controls, alerts, and edge cases still work on the deterministic fallback.

## Deploy

See [DEPLOY.md](./DEPLOY.md) — **Vercel Hobby + Firebase services** is the
path ($0, no card). Firebase Spark can't host a backend (Cloud Functions require
Blaze), so Vercel runs the Next.js app while Firebase contributes Firestore, FCM,
Auth, Remote Config, Storage, and Analytics via env vars.

## Project layout

```
src/lib/
  graph/{stadiumGraph,pathfinder,jitter,forecast,rendezvous}.ts  deterministic core
  events.ts, alerting.ts                                         crossing detection + FCM orchestration
  gemini/{client,tools,nodeCatalog}.ts                           3-tool XAI layer (dispatchToolCall extracted)
  firebase/{admin,client,auth,profile,storage,analytics}.ts     Firebase (server / browser)
  occupancy.ts, sim/{tick,state}.ts, chatGuard.ts                live provider + cost guard
src/app/
  api/{chat,crowd,sim/gates,sim/tick,fcm/register,ops}/route.ts
  ops/page.tsx                                                   organizer view (secondary)
  components/{StadiumMap,ChatPanel,RouteExplanation,TicketBinder}.tsx
  hooks/{useCrowdState,useAuthProfile}.ts
tests/                                                           12 files, 102 tests
```
