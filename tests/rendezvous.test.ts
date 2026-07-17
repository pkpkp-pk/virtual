import { describe, it, expect } from "vitest";
import { findRendezvous } from "@/lib/graph/rendezvous";
import { occupancyAtTime, NODE_MAP } from "@/lib/graph/stadiumGraph";
import type { OccupancyState } from "@/lib/types";

function occ(overrides: Record<string, number> = {}, t = 60): OccupancyState {
  return { ...occupancyAtTime(t), ...overrides };
}

// Rendezvous is a new entry point into the existing Dijkstra engine — fully
// deterministic, no LLM, no live source.

describe("findRendezvous", () => {
  it("returns no_path with fewer than 2 valid starts", () => {
    const r = findRendezvous({
      starts: ["gate_b"],
      occupancy: occ(),
    });
    expect(r.status).toBe("no_path");
    expect(r.suggestions).toEqual([]);
  });

  it("suggests amenity/concourse meeting spots and ranks them by score", () => {
    const r = findRendezvous({
      starts: ["gate_b", "gate_d"],
      occupancy: occ(),
    });
    expect(r.status).toBe("ok");
    expect(r.suggestions.length).toBeGreaterThan(0);
    // Only amenities/concourses are candidates.
    for (const s of r.suggestions) {
      expect(["amenity", "concourse"]).toContain(NODE_MAP[s.nodeId].type);
    }
    // Scores are ascending (best first).
    for (let i = 1; i < r.suggestions.length; i++) {
      expect(r.suggestions[i].score).toBeGreaterThanOrEqual(r.suggestions[i - 1].score);
    }
  });

  it("provides a per-person route from each start to the suggested spot", () => {
    const r = findRendezvous({
      starts: ["gate_b", "gate_d"],
      occupancy: occ(),
    });
    const top = r.suggestions[0];
    expect(top.routes).toHaveLength(2);
    const startIds = top.routes.map((x) => x.startId).sort();
    expect(startIds).toEqual(["gate_b", "gate_d"].sort());
    for (const route of top.routes) {
      expect(route.path[0]).toBe(route.startId);
      expect(route.path.at(-1)).toBe(top.nodeId);
    }
  });

  it("prefers an empty meeting spot over an equally-cheap jammed one", () => {
    // Jam one concourse so its crowd multiplier is high; an amenity with the
    // same combined travel cost should rank above it. With everything else
    // default, just confirm a heavily jammed candidate is NOT the top pick when
    // a calmer alternative exists.
    const jammed = "junction_c";
    const r = findRendezvous({
      starts: ["gate_b", "gate_d"],
      occupancy: occ({ [jammed]: NODE_MAP[jammed].capacity }),
    });
    expect(r.status).toBe("ok");
    // The jammed concourse, if it appears, must not beat a calmer spot: i.e. it
    // is not first, OR every spot is jammed. Calmer spots exist, so it shouldn't
    // be #1.
    expect(r.suggestions[0].nodeId).not.toBe(jammed);
  });

  it("is deterministic for identical inputs", () => {
    const a = findRendezvous({ starts: ["gate_b", "gate_d", "sec_126"], occupancy: occ() });
    const b = findRendezvous({ starts: ["gate_b", "gate_d", "sec_126"], occupancy: occ() });
    expect(a).toEqual(b);
  });

  it("handles three starts", () => {
    const r = findRendezvous({
      starts: ["gate_b", "gate_d", "sec_126"],
      occupancy: occ(),
    });
    expect(r.status).toBe("ok");
    expect(r.suggestions[0].routes).toHaveLength(3);
  });

  it("respects closed gates (a start at a closed gate is dropped)", () => {
    const r = findRendezvous({
      starts: ["gate_b", "gate_c"],
      occupancy: occ(),
      closedGates: ["gate_c"],
    });
    // gate_c closed -> only one valid start -> no_path.
    expect(r.status).toBe("no_path");
  });
});
