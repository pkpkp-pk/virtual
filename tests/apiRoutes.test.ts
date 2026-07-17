import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { POST as fcmRegister } from "@/app/api/fcm/register/route";
import { GET as opsGet } from "@/app/api/ops/route";
import { POST as tickPost } from "@/app/api/sim/tick/route";
import { POST as chatPost } from "@/app/api/chat/route";
import type { ChatOutcome } from "@/lib/gemini/client";

// API-boundary tests: the route handlers' validation + secret gating + the chat
// cost-guard (rate limit + cache), with the Firebase Admin SDK and Gemini
// mocked so we exercise the control flow without network calls.

const mocks = vi.hoisted(() => ({
  firebaseConfigured: vi.fn(),
  subscribeToTopic: vi.fn(),
  readRouteStats: vi.fn(),
  readRecentEvents: vi.fn(),
  incrementRouteStat: vi.fn(),
  readClosedGates: vi.fn(),
  runChat: vi.fn(),
  runChatStream: vi.fn(),
}));

vi.mock("@/lib/firebase/admin", () => ({
  firebaseConfigured: mocks.firebaseConfigured,
  subscribeToTopic: mocks.subscribeToTopic,
  readRouteStats: mocks.readRouteStats,
  readRecentEvents: mocks.readRecentEvents,
  incrementRouteStat: mocks.incrementRouteStat,
  readClosedGates: mocks.readClosedGates,
  writeClosedGates: vi.fn(),
  readGateState: vi.fn(),
  writeGateState: vi.fn(),
  addEvent: vi.fn(),
  sendEventNotifications: vi.fn(),
  getThresholds: vi.fn().mockResolvedValue({
    overCapacityThreshold: 0.9,
    calmThreshold: 0.7,
    forecastHorizonMin: 15,
  }),
  DEFAULT_THRESHOLDS: {
    overCapacityThreshold: 0.9,
    calmThreshold: 0.7,
    forecastHorizonMin: 15,
  },
}));
vi.mock("@/lib/gemini/client", () => ({
  runChat: mocks.runChat,
  runChatStream: mocks.runChatStream,
}));

let uniq = 0;
const fakeOutcome: ChatOutcome = {
  text: "ok",
  routeResult: null,
  occupancySource: "jitter",
  scenarioTime: 0,
};

const req = (path: string, init: RequestInit & { json?: unknown } = {}) => {
  const { json, headers, ...rest } = init;
  return new Request(`https://example.com${path}`, {
    ...rest,
    headers: json ? { "content-type": "application/json", ...(headers as Record<string, string>) } : headers,
    body: json ? JSON.stringify(json) : (init as { body?: BodyInit }).body,
  });
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.firebaseConfigured.mockReturnValue(false); // default: no Firestore calls
  mocks.subscribeToTopic.mockResolvedValue(undefined);
  mocks.readRouteStats.mockResolvedValue([]);
  mocks.readRecentEvents.mockResolvedValue([]);
  mocks.incrementRouteStat.mockResolvedValue(undefined);
  mocks.readClosedGates.mockResolvedValue([]);
  mocks.runChatStream.mockImplementation(async (_q: unknown, _o: unknown, onText?: (d: string) => void) => {
    if (onText) onText(fakeOutcome.text);
    return fakeOutcome;
  });
});
afterEach(() => {
  delete process.env.OPS_SECRET;
  delete process.env.SIM_CRON_SECRET;
});

/** Read the NDJSON chat stream into a list of events. */
async function readChatStream(res: Response): Promise<{ type: string; [k: string]: unknown }[]> {
  const events: { type: string; [k: string]: unknown }[] = [];
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim()) events.push(JSON.parse(line));
    }
  }
  return events;
}

describe("/api/fcm/register", () => {
  it("400 when token is missing", async () => {
    mocks.firebaseConfigured.mockReturnValue(true);
    const res = await fcmRegister(req("/api/fcm/register", { method: "POST", json: {} }));
    expect(res.status).toBe(400);
  });

  it("subscribes to global + gate_{id} for a valid token + gate", async () => {
    mocks.firebaseConfigured.mockReturnValue(true);
    const res = await fcmRegister(
      req("/api/fcm/register", { method: "POST", json: { token: "tok", gateId: "gate_c" } })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.topics).toEqual(["global", "gate_gate_c"]);
    expect(mocks.subscribeToTopic).toHaveBeenCalledTimes(2);
  });

  it("subscribes only to global when the gateId isn't a gate", async () => {
    mocks.firebaseConfigured.mockReturnValue(true);
    const res = await fcmRegister(
      req("/api/fcm/register", { method: "POST", json: { token: "tok", gateId: "sec_126" } })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.topics).toEqual(["global"]);
    expect(mocks.subscribeToTopic).toHaveBeenCalledTimes(1);
  });

  it("503 when Firebase isn't configured", async () => {
    mocks.firebaseConfigured.mockReturnValue(false);
    const res = await fcmRegister(
      req("/api/fcm/register", { method: "POST", json: { token: "tok" } })
    );
    expect(res.status).toBe(503);
  });
});

describe("/api/ops", () => {
  it("401 when OPS_SECRET is set and the header is wrong", async () => {
    process.env.OPS_SECRET = "s3cr3t";
    const res = await opsGet(req("/api/ops", { headers: { "x-ops-secret": "wrong" } }));
    expect(res.status).toBe(401);
  });

  it("200 with the correct secret", async () => {
    process.env.OPS_SECRET = "s3cr3t";
    const res = await opsGet(req("/api/ops", { headers: { "x-ops-secret": "s3cr3t" } }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.phase).toBeDefined();
    expect(Array.isArray(body.gateLoads)).toBe(true);
  });

  it("open (200) when OPS_SECRET is unset", async () => {
    const res = await opsGet(req("/api/ops"));
    expect(res.status).toBe(200);
  });
});

describe("/api/sim/tick", () => {
  it("401 when SIM_CRON_SECRET is set and the header is wrong", async () => {
    process.env.SIM_CRON_SECRET = "cron-sec";
    const res = await tickPost(
      req("/api/sim/tick", { method: "POST", headers: { "x-cron-secret": "nope" } })
    );
    expect(res.status).toBe(401);
  });

  it("200 with the correct secret and returns a snapshot", async () => {
    process.env.SIM_CRON_SECRET = "cron-sec";
    const res = await tickPost(
      req("/api/sim/tick", { method: "POST", headers: { "x-cron-secret": "cron-sec" } })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.t).toBeDefined();
    expect(body.phase).toBeDefined();
    expect(Array.isArray(body.hotspots)).toBe(true);
  });
});

describe("/api/chat", () => {
  it("400 when query is missing", async () => {
    const res = await chatPost(
      req("/api/chat", { method: "POST", json: {}, headers: { "x-forwarded-for": `ip-${++uniq}` } })
    );
    expect(res.status).toBe(400);
  });

  it("streams the outcome (text + done events) for a valid request", async () => {
    const res = await chatPost(
      req("/api/chat", {
        method: "POST",
        json: { query: `q-${++uniq}` },
        headers: { "x-forwarded-for": `ip-${++uniq}` },
      })
    );
    expect(res.status).toBe(200);
    const events = await readChatStream(res);
    expect(events.some((e) => e.type === "text" && e.delta === "ok")).toBe(true);
    expect(events.some((e) => e.type === "done")).toBe(true);
    expect(mocks.runChatStream).toHaveBeenCalledTimes(1);
  });

  it("serves a repeat single-turn request from cache (runChatStream called once)", async () => {
    const q = `q-cache-${++uniq}`;
    const ip = `ip-cache-${++uniq}`;
    await chatPost(req("/api/chat", { method: "POST", json: { query: q }, headers: { "x-forwarded-for": ip } }));
    await chatPost(req("/api/chat", { method: "POST", json: { query: q }, headers: { "x-forwarded-for": ip } }));
    expect(mocks.runChatStream).toHaveBeenCalledTimes(1); // second was a cache hit
  });

  it("does NOT cache multi-turn (history) requests", async () => {
    const q = `q-multi-${++uniq}`;
    const ip = `ip-multi-${++uniq}`;
    const history = [{ role: "user", text: "earlier" }];
    await chatPost(req("/api/chat", { method: "POST", json: { query: q, history }, headers: { "x-forwarded-for": ip } }));
    await chatPost(req("/api/chat", { method: "POST", json: { query: q, history }, headers: { "x-forwarded-for": ip } }));
    expect(mocks.runChatStream).toHaveBeenCalledTimes(2); // follow-ups bypass cache
  });

  it("429 after the per-IP rate cap (10/min)", async () => {
    const q = `q-rl-${++uniq}`;
    const ip = `ip-rl-${++uniq}`;
    let lastStatus = 200;
    for (let i = 0; i < 11; i++) {
      const res = await chatPost(
        req("/api/chat", { method: "POST", json: { query: q }, headers: { "x-forwarded-for": ip } })
      );
      lastStatus = res.status;
    }
    expect(lastStatus).toBe(429);
  });
});
