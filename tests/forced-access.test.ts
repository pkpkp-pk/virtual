import { describe, it, expect } from "vitest";
import { applyForcedAccess } from "@/lib/gemini/client";

// Accessibility must be deterministic: the `accessible` flag is forced onto the
// find_route tool call regardless of what the model emitted. These tests pin
// that contract without needing a Gemini call.

describe("applyForcedAccess", () => {
  it("forces true when forced=true, overriding a model false", () => {
    const out = applyForcedAccess(
      { from: "entry_plaza", to: "sec_126", accessible: false },
      true
    );
    expect(out.accessible).toBe(true);
    // Other args preserved.
    expect(out.from).toBe("entry_plaza");
    expect(out.to).toBe("sec_126");
  });

  it("forces true when the model omitted accessible entirely", () => {
    const out = applyForcedAccess({ from: "entry_plaza", to: "sec_126" }, true);
    expect(out.accessible).toBe(true);
  });

  it("forces false when forced=false, overriding a model true", () => {
    const out = applyForcedAccess(
      { from: "entry_plaza", to: "sec_126", accessible: true },
      false
    );
    expect(out.accessible).toBe(false);
  });

  it("leaves args untouched when forced is undefined (model decides)", () => {
    const args = { from: "entry_plaza", to: "sec_126", accessible: true };
    expect(applyForcedAccess(args, undefined)).toBe(args);
    const args2 = { from: "entry_plaza", to: "sec_126" };
    expect(applyForcedAccess(args2, undefined)).toBe(args2);
  });

  it("does not mutate the input args object", () => {
    const args = { from: "entry_plaza", to: "sec_126", accessible: false };
    applyForcedAccess(args, true);
    expect(args.accessible).toBe(false); // original untouched
  });
});
