import { describe, it, expect, vi, afterEach } from "vitest";
import { rateLimited, withCache } from "@/lib/chatGuard";
import type { ChatOutcome } from "@/lib/gemini/client";

// The chat cost-guard is pure in-memory logic. These pin its contract: the rate
// limiter caps per-IP requests and resets per window, and the cache is keyed on
// (query, accessible, time-bucket) with a short TTL — so identical repeat
// queries skip the LLM call (cost optimization) at the cost of ~30s staleness
// if Firestore state (e.g. a gate closure) changes underneath a cached entry.

let uniq = 0;
const fakeOutcome = (text: string): ChatOutcome => ({
  text,
  routeResult: null,
  occupancySource: "jitter",
  scenarioTime: 0,
});

afterEach(() => vi.restoreAllMocks());

describe("rateLimited", () => {
  it("allows up to 10 requests per IP then rejects the 11th", () => {
    const ip = `ip-cap-${++uniq}`;
    for (let i = 0; i < 10; i++) expect(rateLimited(ip)).toBe(false);
    expect(rateLimited(ip)).toBe(true);
  });

  it("tracks IPs independently", () => {
    const a = `ip-a-${++uniq}`;
    const b = `ip-b-${++uniq}`;
    for (let i = 0; i < 10; i++) rateLimited(a);
    expect(rateLimited(a)).toBe(true); // a is capped
    expect(rateLimited(b)).toBe(false); // b is unaffected
  });

  it("resets the counter after the 60s window", () => {
    const now = 1_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    const ip = `ip-reset-${++uniq}`;
    for (let i = 0; i < 10; i++) rateLimited(ip);
    expect(rateLimited(ip)).toBe(true);
    vi.spyOn(Date, "now").mockReturnValue(now + 61_000); // new window
    expect(rateLimited(ip)).toBe(false);
  });
});

describe("withCache", () => {
  it("returns null on a miss", () => {
    expect(withCache.get(`miss-${++uniq}`, undefined)).toBeNull();
  });

  it("returns the stored outcome on a hit (and the SAME object — no recompute)", () => {
    const q = `hit-${++uniq}`;
    const o = fakeOutcome("hello");
    withCache.set(q, undefined, o);
    expect(withCache.get(q, undefined)).toBe(o); // identity: stale-but-cached, not recomputed
  });

  it("distinguishes keys by the accessible flag", () => {
    const q = `acc-${++uniq}`;
    const o = fakeOutcome("a");
    withCache.set(q, true, o);
    expect(withCache.get(q, false)).toBeNull();
    expect(withCache.get(q, true)).toBe(o);
  });

  it("distinguishes keys by the query text", () => {
    const qa = `qa-${++uniq}`;
    const qb = `qb-${++uniq}`;
    withCache.set(qa, undefined, fakeOutcome("a"));
    expect(withCache.get(qb, undefined)).toBeNull();
  });

  it("is short-lived: a get ~30s later misses (TTL/bucket expiry)", () => {
    const now = 5_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    const q = `ttl-${++uniq}`;
    withCache.set(q, undefined, fakeOutcome("t"));
    expect(withCache.get(q, undefined)).not.toBeNull(); // fresh
    vi.spyOn(Date, "now").mockReturnValue(now + 31_000); // past the ~30s cache window
    expect(withCache.get(q, undefined)).toBeNull();
  });
});
