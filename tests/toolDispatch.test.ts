import { describe, it, expect } from "vitest";
import { dispatchToolCall } from "@/lib/gemini/client";
import { occupancyAtTime } from "@/lib/graph/stadiumGraph";
import type { OccupancySnapshot } from "@/lib/occupancy";

// The 3-tool Gemini loop's per-call logic, extracted as a pure dispatcher so the
// worst-case paths can be pinned without a Gemini call: forced accessibility
// overriding the model, node-resolution failures, each tool's happy path, and
// unknown-tool handling.

const occ: OccupancySnapshot = {
  state: occupancyAtTime(0),
  closedGates: [],
  source: "jitter",
  t: 0,
  phase: "arrival",
};

describe("dispatchToolCall — find_route", () => {
  it("returns an ok route + routeResult for a valid request", () => {
    const out = dispatchToolCall(
      { name: "find_route", args: { from: "entry_plaza", to: "sec_126" } },
      undefined,
      occ
    );
    expect(out.routeResult).not.toBeUndefined();
    expect(out.routeResult!.status).toBe("ok");
    expect(out.response.status).toBe("ok");
  });

  it("forces accessible=true from opts even when the model emitted false", () => {
    // sec_300 is non-accessible -> with accessible forced true, no accessible path.
    const forced = dispatchToolCall(
      { name: "find_route", args: { from: "entry_plaza", to: "sec_300", accessible: false } },
      { accessible: true },
      occ
    );
    expect(forced.routeResult!.status).toBe("no_accessible_path");

    // Without the force, the model's accessible=false stands -> route is ok.
    const unforced = dispatchToolCall(
      { name: "find_route", args: { from: "entry_plaza", to: "sec_300", accessible: false } },
      undefined,
      occ
    );
    expect(unforced.routeResult!.status).toBe("ok");
  });

  it("returns an error part (no routeResult) when origin doesn't resolve", () => {
    const out = dispatchToolCall(
      { name: "find_route", args: { from: "the moon", to: "sec_126" } },
      undefined,
      occ
    );
    expect(out.routeResult).toBeUndefined();
    expect(out.response.status).toBe("error");
  });
});

describe("dispatchToolCall — forecast_crowd", () => {
  it("returns a forecast with a per-minute projection", () => {
    const out = dispatchToolCall(
      { name: "forecast_crowd", args: { node: "gate_c", horizonMin: 5 } },
      undefined,
      occ
    );
    expect(out.routeResult).toBeUndefined();
    const r = out.response;
    expect(r.nowCapacityPct).toBeDefined();
    expect(Array.isArray(r.forecast)).toBe(true);
    expect((r.forecast as unknown[]).length).toBeGreaterThan(0);
  });

  it("returns an error part when the node doesn't resolve", () => {
    const out = dispatchToolCall(
      { name: "forecast_crowd", args: { node: "nowhere" } },
      undefined,
      occ
    );
    expect(out.response.status).toBe("error");
  });
});

describe("dispatchToolCall — find_rendezvous", () => {
  it("returns ranked meeting spots for >=2 starts", () => {
    const out = dispatchToolCall(
      { name: "find_rendezvous", args: { starts: ["gate_b", "gate_d"] } },
      undefined,
      occ
    );
    expect(out.routeResult).toBeUndefined();
    const r = out.response;
    expect(r.status).toBe("ok");
    expect(Array.isArray(r.suggestions)).toBe(true);
    expect((r.suggestions as unknown[]).length).toBeGreaterThan(0);
  });

  it("returns an error part for fewer than 2 starts", () => {
    const out = dispatchToolCall(
      { name: "find_rendezvous", args: { starts: ["gate_b"] } },
      undefined,
      occ
    );
    expect(out.response.status).toBe("error");
  });
});

describe("dispatchToolCall — unknown tool", () => {
  it("returns an 'unknown function' error part", () => {
    const out = dispatchToolCall({ name: "bogus_tool" }, undefined, occ);
    expect(out.response.error).toBe("unknown function");
    expect(out.routeResult).toBeUndefined();
  });
});
