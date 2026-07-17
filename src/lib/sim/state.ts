// Dev-only in-memory simulation controls. Used as a fallback when Firestore
// isn't configured so the demo (gate-closure, etc.) still works locally and on
// a single Cloud Run instance. In production these persist in Firestore
// (crowdState/_meta.closedGates) via the admin module.

let devClosedGates: string[] = [];

export function getDevClosedGates(): string[] {
  return [...devClosedGates];
}

export function setDevClosedGates(gates: string[]): string[] {
  devClosedGates = [...new Set(gates)];
  return [...devClosedGates];
}
