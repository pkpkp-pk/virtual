// Cost guard for the chat endpoint: a per-IP rate limiter + a short-lived
// response cache. In-memory and per-instance (fine for a demo / single Cloud
// Function instance; not a distributed store). The engineering story: the
// engine rate-limits the expensive LLM call and caches deterministic-adjacent
// results, so repeated/near-identical queries don't re-pay the Gemini cost.
//
// Cache key = (query, accessible, bucket30) where bucket30 floors the scenario
// clock to a 30s window. The crowd model is a pure function of t, so two
// identical requests within 30s see effectively the same state. The deterministic
// XAI panel on the client always re-renders from the latest /api/crowd poll, so
// any staleness only affects the cached LLM explanation text.

import { scenarioTime } from "./occupancy";
import type { ChatOutcome } from "./gemini/client";

const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 10; // 10 req / min / IP
const CACHE_TTL_MS = 30_000;
const CACHE_BUCKET_S = 30;

interface RateBucket {
  count: number;
  windowStart: number;
}
const rateBuckets = new Map<string, RateBucket>();

interface CacheEntry {
  outcome: ChatOutcome;
  expiresAt: number;
}
const cache = new Map<string, CacheEntry>();

/** True if `ip` has exceeded the per-window request cap. */
export function rateLimited(ip: string): boolean {
  const now = Date.now();
  const b = rateBuckets.get(ip);
  if (!b || now - b.windowStart >= RATE_WINDOW_MS) {
    rateBuckets.set(ip, { count: 1, windowStart: now });
    return false;
  }
  b.count += 1;
  return b.count > RATE_MAX;
}

function cacheKey(query: string, accessible: boolean | undefined): string {
  const t = scenarioTime();
  const bucket = Math.floor(t / CACHE_BUCKET_S);
  return `${query}${accessible ?? "any"}${bucket}`;
}

export const withCache = {
  get(query: string, accessible: boolean | undefined): ChatOutcome | null {
    const k = cacheKey(query, accessible);
    const e = cache.get(k);
    if (!e) return null;
    if (Date.now() > e.expiresAt) {
      cache.delete(k);
      return null;
    }
    return e.outcome;
  },
  set(query: string, accessible: boolean | undefined, outcome: ChatOutcome): void {
    cache.set(cacheKey(query, accessible), {
      outcome,
      expiresAt: Date.now() + CACHE_TTL_MS,
    });
  },
};
